#!/usr/bin/env node
// Drive one real preview through the product, and time it honestly.
//
//   node --experimental-sqlite control-plane/scripts/live-provision.js <pr-number> [--destroy]
//
// This is the instrument P0-9 measures with, not a test fixture. The clock
// starts when the control plane decides to provision — the moment it writes a
// deployment row and asks the orchestrator — and stops at the first external
// HTTP 200 on the hostname a reviewer would open. Nothing before the decision
// counts, which is what the old commit-timestamp measurement got wrong, and
// nothing after the URL answers counts either.
//
// Milestones in between are recorded for diagnosis only. They are not the
// measurement: an Application existing and a pod being Ready are both true in
// the failure this platform actually had, where every pod was Healthy and every
// URL returned 503.
'use strict';

const st = require('../src/persistence/store.js');
const { PreviewService, AuditService } = require('../src/services/previews.js');
const { ArgoCDOrchestrator } = require('../src/orchestration/orchestrator.js');
const { KubectlCluster, probe } = require('../src/orchestration/cluster.js');
const { GitHubCliClient } = require('../src/github/client.js');
const slo = require('../src/services/slo.js');

const OWNER = 'DevankSilswal';
const REPO = 'gitops-pr-preview';
const SLUG = 'devanksilswal-gitops-pr-preview';
const BASE_HOST = '20-24-211-179.nip.io';
const DB_FILE = process.env.CONTROL_PLANE_DB || '/tmp/stackpreview-live.db';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function main() {
  const prNumber = Number(process.argv[2]);
  const destroyAfter = process.argv.includes('--destroy');
  if (!Number.isInteger(prNumber)) throw new Error('usage: live-provision.js <pr-number> [--destroy]');

  const db = st.open(DB_FILE);
  st.migrate(db);
  const store = st.createStore(db);

  // Idempotent setup: the same organisation, project and repository every run.
  let org = store.db.prepare('SELECT * FROM organizations WHERE github_login = ?').get(OWNER.toLowerCase());
  if (!org) org = store.createOrganization({ name: OWNER, githubLogin: OWNER.toLowerCase() });
  let project = store.db.prepare('SELECT * FROM projects WHERE slug = ?').get(SLUG);
  if (!project) project = store.createProject({ organizationId: org.id, name: 'GitOps PR Preview', slug: SLUG });
  let repository = store.findRepository(OWNER, REPO);
  if (!repository) {
    repository = store.connectRepository({
      projectId: project.id, owner: OWNER, name: REPO,
      imageRepository: 'ghcr.io/devanksilswal/preview-app', servicePort: 3000, healthPath: '/api/health',
    });
  }

  const github = new GitHubCliClient();
  const cluster = new KubectlCluster();
  const orchestrator = new ArgoCDOrchestrator({ github, cluster, probe, baseHost: BASE_HOST });
  const audit = new AuditService(store);
  const previews = new PreviewService({
    store, orchestrator, audit,
    platformLimits: { maxEnvironments: 8, maxTtlDays: 7, privatePreviewsAvailable: false, unknownRepositories: 0 },
  });

  const pr = await github.getPullRequest({ owner: OWNER, repo: REPO, prNumber });
  log(`pull request #${prNumber} "${pr.title}" head=${pr.headSha.slice(0, 7)} labels=[${pr.labels}]`);

  // Start from no environment, so what is measured is this run's provisioning
  // and not the tail of something the engine did earlier.
  if (pr.labels.includes('preview')) {
    log('removing the existing preview label so the measurement starts from nothing');
    await github.removeLabel({ owner: OWNER, repo: REPO, prNumber, label: 'preview' });
    const app = `preview-${SLUG}-${prNumber}`;
    for (let i = 0; i < 40; i++) {
      if (!(await cluster.getApplication(app))) break;
      await sleep(5000);
    }
    log('environment is gone; starting clean');
  }

  const milestones = {};
  const mark = (name) => { milestones[name] = iso(); log(`  · ${name}`); };

  // --- the measurement starts here ----------------------------------------
  mark('provisioning_start');
  const t0 = Date.now();

  const created = await previews.onPullRequestOpened({
    owner: OWNER, name: REPO, prNumber, title: pr.title, author: pr.author,
    isBot: false, isFork: pr.isFork, headSha: pr.headSha, updatedAt: pr.updatedAt,
  });
  if (created.outcome !== 'created') {
    log(`the control plane refused: ${created.outcome} — ${created.message || created.reason}`);
    return;
  }
  const previewId = created.preview.id;
  log(`control plane created preview ${previewId} · status ${created.preview.status}`);

  const appName = `preview-${SLUG}-${prNumber}`;
  const url = `https://${SLUG}-pr-${prNumber}.${BASE_HOST}`;
  let sawApplication = false, sawPodReady = false;

  for (let i = 0; i < 60; i++) {
    const app = await cluster.getApplication(appName);
    if (app && !sawApplication) { sawApplication = true; mark('application_created'); }
    if (app && !sawPodReady) {
      const failures = await cluster.podFailures(`${SLUG}-pr-${prNumber}`);
      const podsJson = await cluster.getApplication(appName);
      if (podsJson && podsJson.health === 'Healthy' && failures.length === 0) { sawPodReady = true; mark('workload_healthy'); }
    }

    const preview = await previews.reconcile(previewId);
    if (preview && preview.status === 'READY') {
      mark('first_external_200');
      break;
    }
    if (preview && preview.status === 'FAILED') {
      log(`FAILED: ${preview.status_reason}`);
      break;
    }
    await sleep(5000);
  }

  const finalPreview = store.getPreview(previewId);
  const deployment = store.currentDeployment(previewId);
  const seconds = deployment && deployment.provisioning_seconds;

  console.log('\n=== MEASUREMENT ===');
  console.log(`status              ${finalPreview.status}`);
  console.log(`url                 ${finalPreview.url || url}`);
  for (const [k, v] of Object.entries(milestones)) {
    console.log(`${k.padEnd(20)}${v}  (+${Math.round((Date.parse(v) - t0) / 1000)}s)`);
  }
  console.log(`provisioning_seconds ${seconds ?? 'not recorded'}   trigger=${deployment && deployment.trigger}`);

  if (destroyAfter) {
    console.log('\n=== DESTROY ===');
    const res = await previews.onPullRequestClosed({ owner: OWNER, name: REPO, prNumber });
    log(`destroy: ${res.outcome}`);
    for (let i = 0; i < 30; i++) {
      if (!(await cluster.getApplication(appName))) { log('the engine pruned the environment'); break; }
      await sleep(5000);
    }
    const code = await probe(url);
    log(`the URL now returns ${code}`);
    console.log(`product state: ${store.getPreview(previewId).status}`);
  }

  console.log('\n=== SLO over everything this database has seen ===');
  const all = store.db.prepare('SELECT * FROM deployments').all();
  console.log(JSON.stringify(slo.report(all), null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
