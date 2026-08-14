// The lifecycle test matrix from P0-5.
//
// Every case here is a deletion decision, and most of them are decisions to
// refuse. The ones worth reading twice are the repository that fails to answer
// and the pull request whose timestamp will not parse: both used to be
// indistinguishable from "nothing here", and both would have deleted live
// environments.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const lc = require('./lifecycle.js');

const NOW = Date.parse('2026-08-14T12:00:00Z');
const DAY = 86400000;
const ttlDays = 3;

const repoA = { owner: 'DevankSilswal', repo: 'gitops-pr-preview', slug: 'devanksilswal-gitops-pr-preview' };
const repoB = { owner: 'DevankSilswal', repo: 'notes-board', slug: 'devanksilswal-notes-board' };

const pr = (number, daysIdle, labels = ['preview']) => ({
  number,
  updated_at: daysIdle === null ? null : new Date(NOW - daysIdle * DAY).toISOString(),
  labels: labels.map((name) => ({ name })),
});

const listerFor = (map) => async (repo) => {
  const v = map[repo.repo];
  if (v instanceof Error) throw v;
  return v;
};

const run = async (map, repos = [repoA, repoB]) => {
  const d = await lc.discover({ repos, listPRs: listerFor(map), now: NOW, ttlDays });
  const cap = lc.capacity({ previews: d.previews, unknownRepos: d.unknownRepos, max: 8 });
  const plan = lc.cleanupPlan({ ...d, canWrite: () => true });
  return { ...d, cap, plan };
};

test('both repositories are tracked, not just the platform one', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(27, 1)], 'notes-board': [pr(1, 1)] });
  assert.deepStrictEqual(r.previews.map((p) => p.identity).sort(),
    ['DevankSilswal/gitops-pr-preview#27', 'DevankSilswal/notes-board#1']);
});

test('a repository with zero pull requests deletes nothing', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(27, 1)], 'notes-board': [] });
  assert.strictEqual(r.plan.delete.length, 0);
  assert.strictEqual(r.unknownRepos.length, 0);
});

test('an API failure is UNKNOWN, never empty, and never a deletion', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(27, 1)], 'notes-board': new Error('403 Forbidden') });
  assert.strictEqual(r.unknownRepos.length, 1);
  assert.strictEqual(r.plan.delete.length, 0);
  assert.match(r.plan.unknown[0].reason, /UNKNOWN.*403/);
});

test('an expired preview is a candidate; an active one is not', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(27, 9), pr(28, 1)], 'notes-board': [] });
  assert.deepStrictEqual(r.plan.delete.map((d) => d.number), [27]);
  assert.ok(r.plan.skip.some((s) => s.number === 28 && /active/.test(s.reason)));
});

test('a pinned pull request is never deleted, however old', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(9, 400, ['preview', 'pinned'])], 'notes-board': [] });
  assert.strictEqual(r.plan.delete.length, 0);
  assert.match(r.plan.skip[0].reason, /pinned/);
});

test('an unreadable timestamp is not treated as old', async () => {
  for (const bad of [null, '', 'not-a-date']) {
    const r = await run({ 'gitops-pr-preview': [{ number: 5, updated_at: bad, labels: [{ name: 'preview' }] }], 'notes-board': [] });
    assert.strictEqual(r.plan.delete.length, 0, `deleted on updated_at=${JSON.stringify(bad)}`);
    assert.match(r.plan.skip[0].reason, /unreadable timestamp/);
  }
});

test('a timestamp from the future is unreadable, not infinitely old', async () => {
  assert.strictEqual(lc.idleMillis(new Date(NOW + DAY).toISOString(), NOW), null);
});

test('capacity is global across repositories, not per repository', async () => {
  const many = (n, from) => Array.from({ length: n }, (_, i) => pr(from + i, 1));
  const r = await run({ 'gitops-pr-preview': many(5, 100), 'notes-board': many(3, 200) });
  assert.strictEqual(r.cap.used, 8);
  assert.strictEqual(r.cap.remaining, 0);
  assert.strictEqual(r.cap.admit('DevankSilswal/notes-board#999').admit, false);
});

test('capacity refuses admission while any repository is unknown', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(1, 1)], 'notes-board': new Error('500') });
  const decision = r.cap.admit('DevankSilswal/gitops-pr-preview#2');
  assert.strictEqual(decision.admit, false);
  assert.match(decision.reason, /did not answer/);
});

test('expired previews do not hold capacity open', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(1, 99), pr(2, 1)], 'notes-board': [] });
  assert.strictEqual(r.cap.used, 1);
});

test('a credential that cannot write reports instead of reaping', async () => {
  const d = await lc.discover({
    repos: [repoA, repoB], listPRs: listerFor({ 'gitops-pr-preview': [pr(1, 9)], 'notes-board': [pr(1, 9)] }),
    now: NOW, ttlDays,
  });
  const plan = lc.cleanupPlan({ ...d, canWrite: (p) => p.repo === 'gitops-pr-preview' });
  assert.deepStrictEqual(plan.delete.map((x) => x.identity), ['DevankSilswal/gitops-pr-preview#1']);
  assert.ok(plan.skip.some((s) => s.identity === 'DevankSilswal/notes-board#1' && /cannot write/.test(s.reason)));
});

test('running twice produces the same plan', async () => {
  const map = { 'gitops-pr-preview': [pr(1, 9), pr(2, 1)], 'notes-board': [pr(3, 9)] };
  const a = await run(map);
  const b = await run(map);
  assert.deepStrictEqual(a.plan.delete.map((x) => x.identity), b.plan.delete.map((x) => x.identity));
});

test('pagination: every page is discovered, not just the first', async () => {
  // The lister stands in for github.paginate; the contract under test is that
  // discover consumes whatever the pager yields rather than assuming one page.
  const pages = [Array.from({ length: 100 }, (_, i) => pr(i + 1, 1)), [pr(101, 9)]];
  const r = await lc.discover({
    repos: [repoA], listPRs: async () => pages.flat(), now: NOW, ttlDays,
  });
  assert.strictEqual(r.previews.length, 101);
  assert.ok(r.previews.some((p) => p.number === 101 && p.disposition === 'expired'));
});

test('unlabelled pull requests are not environments and are ignored', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(1, 99, [])], 'notes-board': [] });
  assert.strictEqual(r.previews.length, 0);
  assert.strictEqual(r.plan.delete.length, 0);
});

test('identity is unambiguous across repositories with the same PR number', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(1, 1)], 'notes-board': [pr(1, 1)] });
  const ids = r.previews.map((p) => p.identity);
  assert.strictEqual(new Set(ids).size, 2);
  assert.deepStrictEqual(r.previews.map((p) => p.namespace).sort(),
    ['devanksilswal-gitops-pr-preview-pr-1', 'devanksilswal-notes-board-pr-1']);
});

test('a repository removed from onboarding is simply not queried', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(1, 9)] }, [repoA]);
  assert.strictEqual(r.states.length, 1);
  assert.strictEqual(r.plan.delete.length, 1);
  // Nothing in the plan refers to the de-onboarded repository: orphan handling
  // is deliberately not mass deletion. Its environments are left to be found by
  // the drift checker rather than reaped by a sweep that cannot see the pull
  // requests behind them.
  assert.ok(!JSON.stringify(r.plan).includes('notes-board'));
});

test('the summary reports repository-level failure rather than hiding it', async () => {
  const r = await run({ 'gitops-pr-preview': [pr(1, 1)], 'notes-board': new Error('429 rate limited') });
  const { text, overall } = lc.renderSummary({
    now: NOW, states: r.states, previews: r.previews, cap: r.cap, plan: r.plan, deleted: [], dryRun: true,
  });
  assert.match(text, /429 rate limited/);
  assert.strictEqual(overall, 'PARTIAL');
});
