// What the control plane must never do.
//
// Most of these assert a refusal. The one worth reading first is
// "a preview is not READY until something observed it serving" — it is the
// promise the product makes to a reviewer about to click a link, and the only
// invariant here whose violation is visible to someone outside the team.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const st = require('../src/persistence/store.js');
const state = require('../src/domain/preview-state.js');
const policy = require('../src/domain/policy.js');
const auth = require('../src/auth/authorize.js');
const webhook = require('../src/github/webhook.js');
const { FakeOrchestrator } = require('../src/orchestration/orchestrator.js');
const { PreviewService, AuditService } = require('../src/services/previews.js');

const PLATFORM = { maxEnvironments: 8, maxTtlDays: 7, privatePreviewsAvailable: false };

function fixture() {
  const db = st.open(':memory:');
  st.migrate(db);
  const store = st.createStore(db);
  const org = store.createOrganization({ name: 'Acme', githubLogin: 'acme' });
  const user = store.upsertUser({ githubId: 1, login: 'dev' });
  store.addMembership({ organizationId: org.id, userId: user.id, role: 'developer' });
  const project = store.createProject({ organizationId: org.id, name: 'Pixel Battle', slug: 'pixel-battle' });
  const repo = store.connectRepository({ projectId: project.id, owner: 'acme', name: 'pixel-battle', imageRepository: 'ghcr.io/acme/pixel-battle' });
  const orchestrator = new FakeOrchestrator();
  const audit = new AuditService(store);
  const previews = new PreviewService({ store, orchestrator, platformLimits: PLATFORM, audit });
  return { db, store, org, user, project, repo, orchestrator, audit, previews };
}

const openPR = (n = 24, over = {}) => ({
  owner: 'acme', name: 'pixel-battle', prNumber: n, title: 'Redesign main menu',
  author: 'friend', isBot: false, isFork: false, headSha: 'abc1234def', updatedAt: new Date().toISOString(),
  ...over,
});

// ---------------------------------------------------------------- state machine

test('a preview is not READY until something observed it serving', async () => {
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR());
  const created = f.store.findPreview(f.repo.id, 24);
  assert.strictEqual(created.status, 'BUILDING');

  // The orchestrator says nothing is answering yet.
  let after = await f.previews.reconcile(created.id);
  assert.notStrictEqual(after.status, 'READY', 'went READY without evidence');

  // Now it answers.
  f.orchestrator.markServing({ owner: 'acme', repo: 'pixel-battle', prNumber: 24 });
  after = await f.previews.reconcile(created.id);
  assert.strictEqual(after.status, 'READY');
  assert.ok(after.ready_at, 'READY with no ready_at');
});

test('READY cannot be reached by asserting it', () => {
  assert.throws(() => state.assertTransition('PROVISIONING', 'READY', {}), state.UnconfirmedReady);
  assert.throws(() => state.assertTransition('PROVISIONING', 'READY', { confirmedServing: false }), state.UnconfirmedReady);
  assert.ok(state.assertTransition('PROVISIONING', 'READY', { confirmedServing: true }));
});

test('illegal transitions are refused, not logged', () => {
  assert.throws(() => state.assertTransition('DESTROYED', 'READY', { confirmedServing: true }), state.IllegalTransition);
  assert.throws(() => state.assertTransition('QUEUED', 'READY', { confirmedServing: true }), state.IllegalTransition);
  assert.throws(() => state.assertTransition('DESTROYING', 'BUILDING'), state.IllegalTransition);
});

test('a failed preview still occupies capacity; a destroyed one does not', () => {
  assert.ok(state.occupiesCapacity('FAILED'), 'a failed preview still holds a namespace');
  assert.ok(!state.occupiesCapacity('DESTROYED'));
  assert.ok(!state.occupiesCapacity('REJECTED'), 'a rejected preview was never created');
});

// ---------------------------------------------------------------------- policy

test('capacity is refused at the cap, with a reason a developer can read', () => {
  const previews = Array.from({ length: 8 }, () => ({ status: 'READY', lifecycle: 'ephemeral' }));
  const decision = policy.admit({
    pullRequest: {}, repository: { enabled: 1 },
    policy: { max_environments: 8, fork_policy: 'allow' },
    platformLimits: PLATFORM, census: policy.census(previews),
  });
  assert.strictEqual(decision.admit, false);
  assert.strictEqual(decision.code, 'capacity_full');
  assert.match(decision.message, /8 of 8/);
});

test('an incomplete census refuses admission rather than risking an over-admission', () => {
  const decision = policy.admit({
    pullRequest: {}, repository: { enabled: 1 },
    policy: { max_environments: 8, fork_policy: 'allow' },
    platformLimits: PLATFORM, census: policy.census([]), unknownRepositories: 1,
  });
  assert.strictEqual(decision.admit, false);
  assert.strictEqual(decision.code, 'census_incomplete');
});

test('a fork needs approval by default and says why', () => {
  const decision = policy.admit({
    pullRequest: { isFork: true, approvedForPreview: false }, repository: { enabled: 1 },
    policy: { max_environments: 8, fork_policy: 'approve' },
    platformLimits: PLATFORM, census: policy.census([]),
  });
  assert.strictEqual(decision.code, 'fork_needs_approval');
  assert.match(decision.message, /unreviewed code/);
});

test('a private preview is downgraded loudly on a cluster that cannot honour it', () => {
  const { policy: eff, capped } = policy.effectivePolicy(
    { visibility: 'private', max_environments: 8, ttl_days: 3 }, PLATFORM);
  assert.strictEqual(eff.visibility, 'public');
  const note = capped.find((c) => c.field === 'visibility');
  assert.match(note.reason, /anyone with the URL/);
});

test('a project cannot promise more environments than the node has', () => {
  const { policy: eff, capped } = policy.effectivePolicy(
    { max_environments: 20, ttl_days: 3, visibility: 'public' }, PLATFORM);
  assert.strictEqual(eff.max_environments, 8);
  assert.strictEqual(capped[0].requested, 20);
});

test('an unreadable timestamp does not produce an expiry', () => {
  assert.strictEqual(policy.expiresAt('not-a-date', 3), null);
  assert.strictEqual(policy.expiresAt(new Date(Date.now() + 86400000).toISOString(), 3), null);
});

// --------------------------------------------------------------- authorization

test('a viewer may see a preview but not read its logs', () => {
  const actor = { userId: 'u', roleByOrg: { o1: 'viewer' } };
  const resource = { organizationId: 'o1' };
  assert.ok(auth.can(actor, 'preview.view', resource));
  assert.ok(!auth.can(actor, 'preview.logs', resource), 'logs can contain anything the app logged');
  assert.ok(!auth.can(actor, 'preview.redeploy', resource));
});

test('a developer cannot change policy or pin an environment', () => {
  const actor = { userId: 'u', roleByOrg: { o1: 'developer' } };
  const r = { organizationId: 'o1' };
  assert.ok(auth.can(actor, 'preview.redeploy', r));
  assert.ok(!auth.can(actor, 'policy.update', r));
  assert.ok(!auth.can(actor, 'preview.pin', r));
});

test('membership in one organization grants nothing in another', () => {
  const actor = { userId: 'u', roleByOrg: { o1: 'owner' } };
  assert.ok(auth.can(actor, 'project.view', { organizationId: 'o1' }));
  assert.ok(!auth.can(actor, 'project.view', { organizationId: 'o2' }));
  assert.throws(() => auth.authorize(actor, 'project.view', { organizationId: 'o2' }), auth.Forbidden);
});

test('an anonymous caller is unauthenticated, not merely forbidden', () => {
  assert.throws(() => auth.authorize(null, 'preview.view', { organizationId: 'o1' }), auth.Unauthenticated);
});

// -------------------------------------------------------------------- webhooks

const sign = (body, secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

test('an unsigned or wrongly signed delivery is refused and records nothing', async () => {
  const f = fixture();
  const body = Buffer.from(JSON.stringify({ action: 'opened' }));
  const res = await webhook.receive({
    rawBody: body, secret: 'shh', store: f.store, process: async () => {},
    headers: { 'x-hub-signature-256': sign(body, 'wrong'), 'x-github-delivery': 'd1', 'x-github-event': 'pull_request' },
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(f.store.getWebhookEvent('d1'), null, 'an unverified delivery must not create a row');
});

test('the signature is computed over the raw bytes, not a re-serialised object', () => {
  const secret = 'shh';
  // Same object, different bytes on the wire. GitHub signs what it sent;
  // re-serialising normalises whitespace, and the digest no longer matches.
  const asSent = Buffer.from('{"a": 1, "b": 2}');
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(asSent.toString())));
  assert.notStrictEqual(asSent.toString(), reserialised.toString());
  assert.ok(webhook.verifySignature(asSent, sign(asSent, secret), secret));
  assert.ok(!webhook.verifySignature(reserialised, sign(asSent, secret), secret));
});

test('a redelivered event is a no-op, not a second preview', async () => {
  const f = fixture();
  const payload = {
    action: 'opened',
    pull_request: { number: 24, title: 't', user: { login: 'dev', type: 'User' }, head: { sha: 'abc', repo: { full_name: 'acme/pixel-battle' } }, updated_at: new Date().toISOString() },
    repository: { name: 'pixel-battle', full_name: 'acme/pixel-battle', owner: { login: 'acme' } },
  };
  const body = Buffer.from(JSON.stringify(payload));
  const headers = { 'x-hub-signature-256': sign(body, 'shh'), 'x-github-delivery': 'dup-1', 'x-github-event': 'pull_request' };
  const process = async (intent) => f.previews.onPullRequestOpened({
    owner: intent.owner, name: intent.name, prNumber: intent.prNumber, title: intent.title,
    author: intent.author, isBot: intent.isBot, isFork: intent.isFork, headSha: intent.headSha, updatedAt: intent.updatedAt,
  });

  const first = await webhook.receive({ rawBody: body, headers, secret: 'shh', store: f.store, process });
  const second = await webhook.receive({ rawBody: body, headers, secret: 'shh', store: f.store, process });

  assert.strictEqual(first.body.status, 'accepted');
  assert.strictEqual(second.body.status, 'duplicate');
  assert.strictEqual(f.store.listLivePreviews().length, 1, 'a retry created a second environment');
});

test('a new commit updates the existing preview instead of creating another', async () => {
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR());
  f.orchestrator.markServing({ owner: 'acme', repo: 'pixel-battle', prNumber: 24 });
  const ready = await f.previews.reconcile(f.store.findPreview(f.repo.id, 24).id);
  assert.strictEqual(ready.status, 'READY');

  await f.previews.onPullRequestUpdated({ owner: 'acme', name: 'pixel-battle', prNumber: 24, headSha: 'def5678', updatedAt: new Date().toISOString() });
  assert.strictEqual(f.store.listLivePreviews().length, 1);
  assert.strictEqual(f.store.findPreview(f.repo.id, 24).status, 'UPDATING');
  assert.strictEqual(f.store.listDeployments(ready.id).length, 2, 'the second commit should be a second deployment');
});

test('interpret maps every pull request action to one intent', () => {
  const base = { pull_request: { number: 1, user: {}, head: { repo: {} } }, repository: { owner: {} } };
  assert.strictEqual(webhook.interpret('pull_request', { ...base, action: 'opened' }).intent, 'create_preview');
  assert.strictEqual(webhook.interpret('pull_request', { ...base, action: 'synchronize' }).intent, 'update_preview');
  assert.strictEqual(webhook.interpret('pull_request', { ...base, action: 'closed' }).intent, 'destroy_preview');
  assert.strictEqual(webhook.interpret('pull_request', { ...base, action: 'labeled' }).intent, 'none');
  assert.strictEqual(webhook.interpret('star', {}).intent, 'none');
});

// ---------------------------------------------------------------- destruction

test('closing a pull request destroys its preview, and doing it twice is not an error', async () => {
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR());
  const first = await f.previews.onPullRequestClosed({ owner: 'acme', name: 'pixel-battle', prNumber: 24 });
  assert.strictEqual(first.outcome, 'destroyed');
  const second = await f.previews.onPullRequestClosed({ owner: 'acme', name: 'pixel-battle', prNumber: 24 });
  assert.strictEqual(second.outcome, 'ignored');
});

test('a pinned environment refuses destruction', async () => {
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR());
  const preview = f.store.findPreview(f.repo.id, 24);
  f.store.setLifecycle(preview.id, 'pinned');
  const res = await f.previews.destroy(preview.id, f.user.id);
  assert.strictEqual(res.outcome, 'refused');
  assert.strictEqual(f.store.getPreview(preview.id).destroyed_at, null);
});

test('rollback refuses when nothing has ever succeeded', async () => {
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR());
  const preview = f.store.findPreview(f.repo.id, 24);
  await assert.rejects(() => f.previews.rollback(preview.id, f.user.id), /no previously successful deployment/);
});

// -------------------------------------------------------------------- auditing

test('every mutation leaves an audit trail, and TTL expiry has no human actor', async () => {
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR());
  const preview = f.store.findPreview(f.repo.id, 24);
  await f.previews.destroy(preview.id, null, 'idle past its TTL');

  const events = f.audit.list(f.org.id).map((e) => e.action);
  assert.ok(events.includes('preview.created'));
  assert.ok(events.includes('preview.destroyed'));
  const destroyed = f.audit.list(f.org.id).find((e) => e.action === 'preview.destroyed');
  assert.strictEqual(destroyed.actor_user_id, null, 'the system acted; inventing an actor would be a lie in the record');
});

// ------------------------------------------------------------------ migrations

test('migrations are idempotent', () => {
  const db = st.open(':memory:');
  const first = st.migrate(db);
  const second = st.migrate(db);
  assert.ok(first.length >= 1);
  assert.strictEqual(second.length, 0, 'a re-run reapplied a migration');
});

test('a repository belongs to exactly one project', () => {
  const f = fixture();
  const other = f.store.createProject({ organizationId: f.org.id, name: 'Other', slug: 'other' });
  assert.throws(() => f.store.connectRepository({
    projectId: other.id, owner: 'acme', name: 'pixel-battle', imageRepository: 'ghcr.io/acme/x',
  }), /UNIQUE/);
});

// ------------------------------------------------- found by the first live run

test('an environment that has not appeared yet is not a failure', async () => {
  const { ArgoCDOrchestrator } = require('../src/orchestration/orchestrator.js');
  // A cluster with no Application for this preview, which is what the first few
  // minutes look like: the label is the request and the generator requeues on
  // its own schedule.
  const orchestrator = new ArgoCDOrchestrator({
    github: {}, probe: async () => 0, baseHost: 'test.nip.io',
    cluster: { getApplication: async () => null, podFailures: async () => [] },
  });

  const early = await orchestrator.status({ slug: 's', prNumber: 1, ageSeconds: 5 });
  assert.strictEqual(early.phase, 'pending');
  assert.strictEqual(early.failureKind, undefined,
    'a preview two seconds old was reported as failed — the first live run did exactly this');

  const late = await orchestrator.status({ slug: 's', prNumber: 1, ageSeconds: 600 });
  assert.strictEqual(late.phase, 'absent');
  assert.strictEqual(late.failureKind, 'unknown');
  assert.ok(ArgoCDOrchestrator.GENERATION_GRACE_SECONDS > 300,
    'the grace window must exceed the generator requeue interval');
});

test('a preview that never comes up does not stay READY', async () => {
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR());
  const preview = f.store.findPreview(f.repo.id, 24);
  f.orchestrator.markServing({ owner: 'acme', repo: 'pixel-battle', prNumber: 24 });
  assert.strictEqual((await f.previews.reconcile(preview.id)).status, 'READY');

  // The environment stops answering.
  f.orchestrator.serving.clear();
  const after = await f.previews.reconcile(preview.id);
  assert.notStrictEqual(after.status, 'READY',
    'the product kept claiming READY after the environment stopped serving');
});

// --------------------------------------------------------------------- the SLO

test('the SLO refuses the samples that made the old metric useless', () => {
  const slo = require('../src/services/slo.js');
  const base = { status: 'succeeded', started_at: '2026-08-16T00:00:00Z', trigger: 'open' };
  const rows = [
    { ...base, id: 'a', provisioning_seconds: 94, finished_at: '2026-08-16T00:01:34Z' },
    { ...base, id: 'b', provisioning_seconds: 415673, finished_at: '2026-08-20T19:27:53Z' },  // the commit-timestamp bug
    { ...base, id: 'c', provisioning_seconds: -5, finished_at: '2026-08-16T00:00:00Z' },
    { ...base, id: 'd', provisioning_seconds: 0, finished_at: '2026-08-16T00:00:00Z' },
    { ...base, id: 'e', provisioning_seconds: null, finished_at: '2026-08-16T00:01:00Z' },
    { ...base, id: 'f', provisioning_seconds: 60, finished_at: '2026-08-16T00:05:00Z' },      // disagrees with its own timestamps
    { ...base, id: 'g', status: 'failed', provisioning_seconds: null, finished_at: '2026-08-16T00:01:00Z' },
  ];
  const r = slo.report(rows);
  assert.strictEqual(r.valid, 1, 'only one of these is a real measurement');
  assert.strictEqual(r.byKind.first_provision.p50, 94);
  assert.match(r.rejections.find((x) => x.id === 'b').why, /implausible/);
  assert.match(r.rejections.find((x) => x.id === 'f').why, /disagrees with its own timestamps/);
  assert.strictEqual(r.objective, null, 'an objective must not be invented from one sample');
  assert.match(r.byKind.first_provision.attainment, /withheld/);
});

test('the SLO separates a first provision from a redeploy and a recovery', () => {
  const slo = require('../src/services/slo.js');
  const at = (s) => ({ status: 'succeeded', started_at: '2026-08-16T00:00:00Z',
    finished_at: new Date(Date.parse('2026-08-16T00:00:00Z') + s * 1000).toISOString(), provisioning_seconds: s });
  const r = slo.report([
    { ...at(100), id: '1', trigger: 'open' },
    { ...at(40), id: '2', trigger: 'synchronize' },
    { ...at(50), id: '3', trigger: 'redeploy' },
    { ...at(70), id: '4', trigger: 'rollback' },
  ]);
  assert.strictEqual(r.byKind.first_provision.samples, 1);
  assert.strictEqual(r.byKind.redeploy.samples, 2);
  assert.strictEqual(r.byKind.recovery.samples, 1);
  assert.strictEqual(r.firstProvisions, 1);
});

test('a redeploy is legal from every state a user can see', () => {
  // Found live: redeploy assumed it always started from rest, and threw when a
  // user asked for one while the environment was already updating.
  for (const from of ['READY', 'UPDATING', 'PROVISIONING', 'FAILED']) {
    assert.ok(state.canTransition(from, 'BUILDING'), `redeploy refused from ${from}`);
  }
  assert.ok(!state.canTransition('DESTROYED', 'BUILDING'), 'a destroyed preview is not redeployable');
});

test('a redeploy asked for while one is running is idempotent, not illegal', () => {
  assert.ok(state.canTransition('BUILDING', 'BUILDING'));
});

// ---------------------------------------------------------- deployment config

test('the control plane refuses to start without the secrets it needs', () => {
  const { load, ConfigError } = require('../src/config.js');
  assert.throws(() => load({ PREVIEW_BASE_HOST: 'x.nip.io' }), ConfigError);
  try {
    load({ PREVIEW_BASE_HOST: 'x.nip.io' });
  } catch (err) {
    assert.match(err.message, /GITHUB_APP_ID/);
    assert.match(err.message, /GITHUB_WEBHOOK_SECRET/);
  }
});

test('it refuses to be exposed publicly without a webhook secret', () => {
  const { load, ConfigError } = require('../src/config.js');
  assert.throws(() => load({
    PREVIEW_BASE_HOST: 'x.nip.io', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k',
    EXPOSE_PUBLICLY: 'true',
  }), (err) => err instanceof ConfigError && /unauthenticated endpoint on the internet/.test(err.message));
});

test('private previews default to unavailable, which is the safe answer', () => {
  const { load } = require('../src/config.js');
  const cfg = load({ PREVIEW_BASE_HOST: 'x.nip.io', GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'k', GITHUB_WEBHOOK_SECRET: 's' });
  assert.strictEqual(cfg.platformLimits.privatePreviewsAvailable, false);
  assert.strictEqual(cfg.exposePublicly, false);
});

test('redaction never prints a secret', () => {
  const { load, redact } = require('../src/config.js');
  const cfg = load({ PREVIEW_BASE_HOST: 'x.nip.io', GITHUB_APP_ID: '42',
    GITHUB_APP_PRIVATE_KEY: 'SUPER-SECRET-KEY-MATERIAL', GITHUB_WEBHOOK_SECRET: 'SUPER-SECRET-HMAC' });
  const printed = JSON.stringify(redact(cfg));
  assert.ok(!printed.includes('SUPER-SECRET-KEY-MATERIAL'));
  assert.ok(!printed.includes('SUPER-SECRET-HMAC'));
  assert.match(printed, /\[set\]/);
  assert.match(printed, /bytes/);
});

test('the App JWT is signed, short-lived, and backdated against clock skew', () => {
  const crypto = require('node:crypto');
  const { appJwt } = require('../src/github/app-auth.js');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });

  const now = 1_800_000_000;
  const token = appJwt({ appId: 42, privateKey: pem, now });
  const [h, p, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url'));

  assert.strictEqual(payload.iss, '42');
  assert.strictEqual(payload.iat, now - 60, 'iat must be backdated; GitHub rejects a future iat outright');
  assert.ok(payload.exp - payload.iat <= 10 * 60, 'GitHub caps App JWT lifetime at ten minutes');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')),
    'the JWT signature does not verify');
});

// --------------------------------------------------- the two ways to reach GitHub

test('each auth mode demands its own credentials and neither accepts the other', () => {
  const { load, redact, ConfigError } = require('../src/config.js');
  const base = { PREVIEW_BASE_HOST: 'x.nip.io', GITHUB_WEBHOOK_SECRET: 'a'.repeat(20) };

  assert.throws(() => load({ ...base, GITHUB_AUTH: 'token' }), /GITHUB_TOKEN is not set/);
  assert.throws(() => load({ ...base, GITHUB_AUTH: 'app' }), /GITHUB_APP_ID is not set/);
  assert.throws(() => load({ ...base, GITHUB_AUTH: 'sudo' }), /must be 'app' or 'token'/);

  // A token does not satisfy app mode, and app credentials do not satisfy token
  // mode — the mode says which posture is in force, so it cannot be inferred.
  assert.throws(() => load({ ...base, GITHUB_AUTH: 'app', GITHUB_TOKEN: 'ghp_x' }), ConfigError);

  const ok = load({ ...base, GITHUB_AUTH: 'token', GITHUB_TOKEN: 'ghp_secret_value' });
  assert.strictEqual(ok.github.authMode, 'token');
});

test('the webhook secret is required in both modes, because it is the only authentication the endpoint has', () => {
  const { load } = require('../src/config.js');
  assert.throws(() => load({ PREVIEW_BASE_HOST: 'x.nip.io', GITHUB_AUTH: 'token', GITHUB_TOKEN: 't' }),
    /GITHUB_WEBHOOK_SECRET is not set/);
});

test('no credential survives redaction', () => {
  const { load, redact } = require('../src/config.js');
  const cfg = load({ PREVIEW_BASE_HOST: 'x.nip.io', GITHUB_AUTH: 'token',
    GITHUB_TOKEN: 'ghp_a_real_looking_token', GITHUB_WEBHOOK_SECRET: 'w'.repeat(32) });
  const printed = JSON.stringify(redact(cfg));
  assert.ok(!printed.includes('ghp_a_real_looking_token'), 'the token appeared in the redacted config');
  assert.ok(!printed.includes('w'.repeat(32)), 'the webhook secret appeared in the redacted config');
  assert.match(printed, /\[16 bytes\]|\[\d+ bytes\]/);
});

test('a token client is not installation-scoped, and says so by returning itself', () => {
  const { GitHubTokenClient } = require('../src/github/token-client.js');
  const client = new GitHubTokenClient({ token: 't' });
  assert.strictEqual(client.forInstallation(12345), client);
  assert.throws(() => new GitHubTokenClient({}), /needs a token/);
});

// ------------------------------------ found when the first real PR went through

test('the reconciler sweeps live previews and reports what changed', async () => {
  const { Reconciler } = require('../src/services/reconciler.js');
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR());
  const preview = f.store.findPreview(f.repo.id, 24);

  const reconciler = new Reconciler({ previews: f.previews, store: f.store, intervalMs: 50 });

  let result = await reconciler.sweep();
  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.changed, 0, 'nothing is serving yet, so nothing should change');

  f.orchestrator.markServing({ owner: 'acme', repo: 'pixel-battle', prNumber: 24 });
  result = await reconciler.sweep();
  assert.strictEqual(result.changed, 1);
  assert.strictEqual(f.store.getPreview(preview.id).status, 'READY',
    'a sweep is the only thing that makes READY reachable without a human opening the page');
});

test('one failing preview does not stop the sweep', async () => {
  const { Reconciler } = require('../src/services/reconciler.js');
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR(1));
  await f.previews.onPullRequestOpened(openPR(2));

  const real = f.previews.reconcile.bind(f.previews);
  let first = true;
  f.previews.reconcile = async (id) => {
    if (first) { first = false; throw new Error('cluster unreachable'); }
    return real(id);
  };

  const result = await new Reconciler({ previews: f.previews, store: f.store }).sweep();
  assert.strictEqual(result.checked, 2);
  assert.strictEqual(result.failed, 1, 'the failure should be counted, not swallowed');
});

test('sweeps do not overlap', async () => {
  const { Reconciler } = require('../src/services/reconciler.js');
  const f = fixture();
  await f.previews.onPullRequestOpened(openPR());
  const reconciler = new Reconciler({ previews: f.previews, store: f.store });
  reconciler.running = true;
  assert.deepStrictEqual(await reconciler.sweep(), { skipped: true });
});

test('the in-cluster adapter knows whether it is in a cluster', () => {
  const { InClusterKubernetes } = require('../src/orchestration/in-cluster.js');
  const saved = process.env.KUBERNETES_SERVICE_HOST;
  delete process.env.KUBERNETES_SERVICE_HOST;
  assert.strictEqual(InClusterKubernetes.available(), false,
    'outside a cluster it must decline, so main falls back to kubectl');
  if (saved) process.env.KUBERNETES_SERVICE_HOST = saved;
});

test('the in-cluster adapter passes the cluster CA rather than trusting fetch to', () => {
  // The first version read the CA into a field and then called fetch, whose
  // undici implementation takes no ca option. Every call failed with "fetch
  // failed" and the reconciler retried forever. This asserts the shape of the
  // fix, since the behaviour itself needs a cluster.
  const source = require('node:fs').readFileSync(
    `${__dirname}/../src/orchestration/in-cluster.js`, 'utf8');
  assert.ok(source.includes("require('node:https')"), 'must use node:https, which accepts a CA');
  assert.ok(!/\bfetch\(/.test(source), 'a fetch call cannot be given the cluster CA');
  assert.ok(/ca: this\.ca/.test(source), 'the CA must be handed to the request, not merely read');
  assert.ok(!/rejectUnauthorized:\s*false/.test(source), 'verification must never be disabled');
});
