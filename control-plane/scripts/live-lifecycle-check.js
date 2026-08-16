#!/usr/bin/env node
// The four convergence properties, proved against the live cluster.
//
//   node --experimental-sqlite control-plane/scripts/live-lifecycle-check.js <pr-number>
//
// The control plane and the engine keep separate state. These are the four
// ways that can go wrong, and each one is checked by breaking it on purpose and
// watching the product notice — not by reading the code and agreeing with it.
'use strict';

const st = require('../src/persistence/store.js');
const { PreviewService, AuditService } = require('../src/services/previews.js');
const { ArgoCDOrchestrator } = require('../src/orchestration/orchestrator.js');
const { KubectlCluster, probe } = require('../src/orchestration/cluster.js');
const { GitHubCliClient } = require('../src/github/client.js');

const OWNER = 'DevankSilswal', REPO = 'gitops-pr-preview';
const SLUG = 'devanksilswal-gitops-pr-preview';

// The base host is not ours to know. scripts/sync-base-host.sh writes it into
// the platform chart from Terraform's public_ip output, and that file is the
// single runtime source of truth — a second copy here is precisely what
// scripts/check-base-host.sh exists to refuse, and it refused this one.
function baseHostFromChart() {
  const fs = require('node:fs');
  const path = require('node:path');
  const values = fs.readFileSync(
    path.join(__dirname, '..', '..', 'deploy', 'platform-chart', 'values.yaml'), 'utf8');
  const match = values.match(/^baseHost:\s*(\S+)\s*$/m);
  if (!match) throw new Error('deploy/platform-chart/values.yaml has no baseHost');
  return match[1];
}

const BASE_HOST = baseHostFromChart();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function main() {
  const prNumber = Number(process.argv[2]);
  const db = st.open(process.env.CONTROL_PLANE_DB || '/tmp/stackpreview-live.db');
  st.migrate(db);
  const store = st.createStore(db);

  const github = new GitHubCliClient();
  const cluster = new KubectlCluster();
  const orchestrator = new ArgoCDOrchestrator({ github, cluster, probe, baseHost: BASE_HOST });
  const previews = new PreviewService({
    store, orchestrator, audit: new AuditService(store),
    platformLimits: { maxEnvironments: 8, maxTtlDays: 7, privatePreviewsAvailable: false, unknownRepositories: 0 },
  });

  const repository = store.findRepository(OWNER, REPO);
  const preview = store.findPreview(repository.id, prNumber);
  const appName = `preview-${SLUG}-${prNumber}`;
  const url = `https://${SLUG}-pr-${prNumber}.${BASE_HOST}`;

  // --- 1. READY means it is actually answering ------------------------------
  const code = await probe(url);
  const observedStatus = store.getPreview(preview.id).status;
  // The detail reports what was found, not what was expected. The first version
  // of this line hardcoded "product=READY" into the message and printed it
  // beside a FAIL, which is the same class of dishonesty this whole exercise is
  // about.
  check('control-plane READY matches a real external 200',
    observedStatus === 'READY' && code === 200, `product=${observedStatus} http=${code}`);

  // --- 2. a duplicate request does not create a second environment ----------
  const before = store.listLivePreviews().length;
  const dup = await previews.onPullRequestOpened({
    owner: OWNER, name: REPO, prNumber, title: 'duplicate', author: 'test',
    isBot: false, isFork: false, headSha: 'deadbeef', updatedAt: new Date().toISOString(),
  });
  check('a duplicate open does not create a second preview',
    store.listLivePreviews().length === before, `outcome=${dup.outcome}, live previews ${before} → ${store.listLivePreviews().length}`);

  // --- 3. a redeploy is a second attempt on the same environment ------------
  const deploymentsBefore = store.listDeployments(preview.id).length;
  await previews.redeploy(preview.id, null);
  const afterRedeploy = store.getPreview(preview.id);
  check('a redeploy records an attempt and leaves READY behind',
    store.listDeployments(preview.id).length === deploymentsBefore + 1 && afterRedeploy.status !== 'READY',
    `deployments ${deploymentsBefore} → ${store.listDeployments(preview.id).length}, status ${afterRedeploy.status}`);

  // It should return to READY on its own, because nothing about the environment
  // actually changed — the image tag is the same.
  let recovered = null;
  for (let i = 0; i < 12; i++) {
    recovered = await previews.reconcile(preview.id);
    if (recovered.status === 'READY') break;
    await sleep(5000);
  }
  check('reconciliation returns it to READY once it is serving again',
    recovered && recovered.status === 'READY', `status=${recovered && recovered.status}`);

  // --- 4. deleting it in the engine updates product state -------------------
  log('removing the label directly in the engine — the product must notice');
  await github.removeLabel({ owner: OWNER, repo: REPO, prNumber, label: 'preview' });
  let noticed = null;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    noticed = await previews.reconcile(preview.id);
    if (noticed.status !== 'READY') break;
  }
  const appGone = !(await cluster.getApplication(appName));
  check('an engine-side deletion stops the product claiming READY',
    noticed && noticed.status !== 'READY', `status=${noticed && noticed.status}, application ${appGone ? 'pruned' : 'still present'}`);

  // --- 5. destroy through the product --------------------------------------
  const destroyed = await previews.onPullRequestClosed({ owner: OWNER, name: REPO, prNumber });
  const finalRow = store.getPreview(preview.id);
  check('destroy through the product marks it destroyed',
    finalRow.status === 'DESTROYED' && finalRow.destroyed_at !== null, `status=${finalRow.status} outcome=${destroyed.outcome}`);

  const again = await previews.onPullRequestClosed({ owner: OWNER, name: REPO, prNumber });
  check('destroying twice is not an error', again.outcome === 'ignored', `outcome=${again.outcome}`);

  console.log('\n=== RESULT ===');
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
