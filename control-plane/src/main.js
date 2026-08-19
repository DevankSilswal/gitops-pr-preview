// The entrypoint. Wires the modules together and starts nothing until the
// configuration it needs actually exists.
'use strict';

const { load, redact, ConfigError } = require('./config.js');
const st = require('./persistence/store.js');
const { createServer } = require('./api/server.js');
const { PreviewService, AuditService } = require('./services/previews.js');
const { ArgoCDOrchestrator } = require('./orchestration/orchestrator.js');
const { KubectlCluster, probe } = require('./orchestration/cluster.js');
const { InClusterKubernetes } = require('./orchestration/in-cluster.js');
const { Reconciler } = require('./services/reconciler.js');
const { GitHubAppClient } = require('./github/app-auth.js');
const { GitHubTokenClient } = require('./github/token-client.js');

const log = (level, message, extra = {}) =>
  console.log(JSON.stringify({ level, message, ...extra, at: new Date().toISOString() }));

function main() {
  let cfg;
  try {
    cfg = load();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Exit rather than start degraded. A control plane that runs without a
      // webhook secret and merely warns will run that way for a month.
      console.error(err.message);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
  log('info', 'starting', { config: redact(cfg) });

  const db = st.open(cfg.databaseFile);
  const applied = st.migrate(db);
  log('info', 'migrations', { applied: applied.length ? applied : 'already current' });
  const store = st.createStore(db);

  // One of two clients, same interface. Everything downstream — the
  // orchestrator, the services, the API — is written against the interface and
  // does not know which one it got, so moving to the App later is a Secret and
  // an environment variable rather than a change to any of it.
  const app = cfg.github.authMode === 'token'
    ? new GitHubTokenClient({ token: cfg.github.token })
    : new GitHubAppClient({ appId: cfg.github.appId, privateKey: cfg.github.privateKey });
  // In the cluster, talk to the API directly with the ServiceAccount. Outside
  // it — the local scripts — kubectl is what is available and already
  // configured. The first deployed build only had the kubectl adapter and could
  // not observe anything at all.
  const cluster = InClusterKubernetes.available()
    ? new InClusterKubernetes()
    : new KubectlCluster();

  // One orchestrator per installation: the token is installation-scoped, which
  // is the point of a GitHub App. A repository's installation id is recorded
  // when it is connected.
  const orchestratorFor = (installationId) => new ArgoCDOrchestrator({
    github: app.forInstallation(installationId),
    cluster, probe, baseHost: cfg.baseHost,
  });

  // Until repositories carry installation ids, the services use a single
  // orchestrator bound to the first installation seen. The seam is here so
  // that becoming per-installation is a change in one place.
  const audit = new AuditService(store);
  const previews = new PreviewService({
    store, audit, platformLimits: cfg.platformLimits,
    orchestrator: orchestratorFor(cfg.github.defaultInstallationId),
  });

  // Without this, reconcile() has no caller on a schedule and a preview can
  // serve 200 indefinitely while the product still reports BUILDING. That is
  // exactly what the first live pull request through the deployed product did,
  // for eleven minutes.
  const reconciler = new Reconciler({ previews, store, log });
  reconciler.start();

  const server = createServer({
    store, previews, audit, cluster, platformLimits: cfg.platformLimits,
    orchestrator: previews.orchestrator,
    webhookSecret: cfg.github.webhookSecret,
    // No dashboard yet, so no session to resolve. Every human endpoint returns
    // 401 until sign-in exists — which is the correct behaviour for an API
    // that can create environments, not a gap.
    sessionFor: () => null,
  });

  server.listen(cfg.port, () => {
    log('info', 'listening', { port: cfg.port, publiclyExposed: cfg.exposePublicly });
  });

  // A control plane killed mid-write leaves a database another process has to
  // recover. SQLite in WAL mode survives it, but finishing in-flight requests
  // first is free.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log('info', 'shutting down', { signal });
      server.close(() => { db.close(); process.exit(0); });
      setTimeout(() => process.exit(1), 10000).unref();
    });
  }
}

if (require.main === module) main();
module.exports = { main };
