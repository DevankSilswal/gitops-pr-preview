// Which preview environments should exist, across every onboarded repository.
//
// This used to be two inline scripts in preview-lifecycle.yml that both asked
// GitHub about `context.repo` — the platform repository and nothing else. The
// consequence was visible in production for nine days: notes-board PR #1 was
// last touched on 2026-08-05, carried the `preview` label throughout, and the
// three-day sweep never saw it because the sweep could not see that repository
// at all. Capacity was counted the same way, so MAX_ENVIRONMENTS was really
// "MAX_ENVIRONMENTS in the platform repository, plus however many everywhere
// else".
//
// The logic lives here rather than in YAML so it can be tested against mocked
// API responses. Every function is pure: callers pass in a lister and a clock,
// which is what makes the failure cases — a repository that 403s, a timestamp
// from the future — reachable in a test instead of only in an incident.
//
// Three invariants, and every one of them is a deletion this code refuses:
//
//   UNKNOWN ≠ EMPTY     a repository that failed to answer has not told us it
//                       has no pull requests, and treating it as empty deletes
//                       every environment it owns.
//   PINNED ≠ EPHEMERAL  the permanent demo is not a pull request and must never
//                       be reachable from a sweep.
//   PRODUCTION ≠ PREVIEW
'use strict';

const fs = require('fs');
const path = require('path');

const PREVIEW_LABEL = 'preview';
const PINNED_LABEL = 'pinned';

/** The one registry. ArgoCD's ApplicationSet reads the same directory. */
function loadOnboarded(dir) {
  const repos = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.yaml')) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const field = (name) => {
      const m = text.match(new RegExp(`^${name}:\\s*['"]?([^'"\n]+)['"]?\\s*$`, 'm'));
      return m ? m[1].trim() : null;
    };
    const owner = field('owner');
    const repo = field('repo');
    const slug = field('slug');
    // A malformed entry is not skipped quietly. An onboarded repository that
    // silently fails to parse is a repository whose environments stop being
    // governed, which is the failure this whole module exists to remove.
    if (!owner || !repo || !slug) {
      throw new Error(`${file}: needs owner, repo and slug — got ${owner}/${repo} (${slug})`);
    }
    repos.push({ owner, repo, slug, file });
  }
  return repos;
}

/**
 * Age of a pull request in milliseconds, or null when the timestamp cannot be
 * trusted. Null is deliberately not "old": a preview is never deleted because
 * its metadata was unreadable.
 */
function idleMillis(updatedAt, now) {
  if (typeof updatedAt !== 'string' || updatedAt === '') return null;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return null;
  // A future timestamp means a clock disagreed somewhere. Treating it as an
  // enormous negative age would keep the environment forever, which is the safe
  // direction, but saying so explicitly is better than relying on the sign.
  if (t > now) return null;
  return now - t;
}

/** Ask one repository what it has, and never guess when it will not say. */
async function queryRepository(repo, listPRs) {
  try {
    const prs = await listPRs(repo);
    return { ...repo, status: 'OK', prs, error: null };
  } catch (err) {
    // 401, 403, 429, 500, a timeout, a DNS failure — all the same conclusion:
    // we do not know. The one thing this must never become is `prs: []`.
    return { ...repo, status: 'UNKNOWN', prs: null, error: String(err && err.message || err) };
  }
}

/**
 * Everything the platform can currently see, and everything it cannot.
 * `now` and `listPRs` are injected so the interesting states are testable.
 */
async function discover({ repos, listPRs, now, ttlDays }) {
  const states = [];
  for (const repo of repos) states.push(await queryRepository(repo, listPRs));

  const previews = [];
  for (const state of states) {
    if (state.status !== 'OK') continue;
    for (const pr of state.prs) {
      const labels = (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
      if (!labels.includes(PREVIEW_LABEL)) continue;

      const idle = idleMillis(pr.updated_at, now);
      const pinned = labels.includes(PINNED_LABEL);
      let disposition;
      if (pinned) disposition = 'pinned';
      else if (idle === null) disposition = 'unknown-timestamp';
      else if (idle > ttlDays * 24 * 60 * 60 * 1000) disposition = 'expired';
      else disposition = 'active';

      previews.push({
        owner: state.owner, repo: state.repo, slug: state.slug,
        number: pr.number, updatedAt: pr.updated_at,
        idleDays: idle === null ? null : +(idle / 86400000).toFixed(2),
        disposition,
        identity: `${state.owner}/${state.repo}#${pr.number}`,
        namespace: `${state.slug}-pr-${pr.number}`,
        application: `preview-${state.slug}-${pr.number}`,
      });
    }
  }

  const unknownRepos = states.filter((s) => s.status === 'UNKNOWN');
  return { states, previews, unknownRepos };
}

/**
 * Global capacity. The number that matters is across every repository at once;
 * counting per repository is how a cap of eight became a cap of eight each.
 *
 * Environments in an unknown repository are counted as unknown, not as zero,
 * and admission is refused while any repository is unknown rather than risking
 * an over-admission that nothing would notice.
 */
function capacity({ previews, unknownRepos, max }) {
  const counted = previews.filter((p) => p.disposition !== 'expired');
  const used = counted.length;
  const unknown = unknownRepos.length;
  const remaining = Math.max(0, max - used);
  return {
    used,
    max,
    remaining,
    unknownRepositories: unknown,
    // The pinned demo is not a pull request in any repository, so it never
    // appears here and never consumes pull-request capacity. It does consume
    // node resources, which is why MAX_ENVIRONMENTS is a cap on a single-node
    // cluster and not a promise about it.
    admit(identity) {
      if (unknown > 0) {
        return { admit: false, reason: `${unknown} repository/repositories did not answer; admitting could exceed the global cap without anything noticing` };
      }
      if (used >= max) {
        return { admit: false, reason: `global capacity is full: ${used}/${max} across all onboarded repositories` };
      }
      return { admit: true, reason: `${used + 1}/${max} after admitting ${identity}` };
    },
  };
}

/**
 * What may be deleted, what must be kept, and what we refuse to decide.
 *
 * `canWrite` answers whether the running credential may modify a given
 * repository. GitHub's per-workflow token is scoped to its own repository, so
 * for every other onboarded repository this returns false and the environment
 * is reported rather than reaped — a limitation with a name, instead of a
 * cleanup that silently fails.
 */
function cleanupPlan({ previews, states, canWrite }) {
  const del = [];
  const skip = [];

  for (const p of previews) {
    if (p.disposition === 'pinned') {
      skip.push({ ...p, reason: 'pinned — never expires' });
    } else if (p.disposition === 'unknown-timestamp') {
      skip.push({ ...p, reason: `unreadable timestamp (${JSON.stringify(p.updatedAt)}) — refusing to treat unreadable as old` });
    } else if (p.disposition === 'active') {
      skip.push({ ...p, reason: `active — idle ${p.idleDays}d` });
    } else if (!canWrite(p)) {
      skip.push({ ...p, reason: `expired at ${p.idleDays}d but this credential cannot write to ${p.owner}/${p.repo}` });
    } else {
      del.push({ ...p, reason: `idle ${p.idleDays}d, past TTL` });
    }
  }

  const unknown = states
    .filter((s) => s.status !== 'OK')
    .map((s) => ({ identity: `${s.owner}/${s.repo}`, reason: `state UNKNOWN (${s.error}) — no cleanup attempted` }));

  return { delete: del, skip, unknown };
}

/** The §23 summary, written so an operator can act on it without the logs. */
function renderSummary({ now, states, previews, cap, plan, deleted, dryRun }) {
  const ok = states.filter((s) => s.status === 'OK');
  const L = [];
  L.push('MULTI-REPO LIFECYCLE RUN', '');
  L.push(`Timestamp:                 ${new Date(now).toISOString()}`);
  L.push(`Mode:                      ${dryRun ? 'DRY RUN — nothing will be modified' : 'ENFORCING'}`);
  L.push(`Repositories discovered:   ${states.length}`);
  L.push(`Successfully queried:      ${ok.length}`);
  L.push(`UNKNOWN:                   ${states.length - ok.length}`);
  L.push(`Active previews:           ${previews.filter((p) => p.disposition === 'active').length}`);
  L.push(`Expired previews:          ${previews.filter((p) => p.disposition === 'expired').length}`);
  L.push(`Unreadable metadata:       ${previews.filter((p) => p.disposition === 'unknown-timestamp').length}`);
  L.push(`Global capacity:           ${cap.used}/${cap.max}`);
  L.push(`Capacity remaining:        ${cap.remaining}`);
  L.push('');
  L.push('Cleanup candidates:');
  for (const d of plan.delete) L.push(`  ${d.identity} → ${d.reason}`);
  if (!plan.delete.length) L.push('  (none)');
  L.push('');
  L.push('Deleted:');
  for (const d of deleted) L.push(`  ${d.identity} → ${d.result}`);
  if (!deleted.length) L.push(dryRun ? '  (dry run — nothing deleted)' : '  (none)');
  L.push('');
  L.push('Skipped:');
  for (const s of plan.skip) L.push(`  ${s.identity} → ${s.reason}`);
  if (!plan.skip.length) L.push('  (none)');
  L.push('');
  L.push('Failures:');
  for (const u of plan.unknown) L.push(`  ${u.identity} → ${u.reason}`);
  if (!plan.unknown.length) L.push('  (none)');
  L.push('');
  const failed = deleted.filter((d) => d.result !== 'ok');
  const overall = plan.unknown.length || failed.length
    ? (deleted.length && !failed.length ? 'PARTIAL' : plan.unknown.length ? 'PARTIAL' : 'FAIL')
    : 'PASS';
  L.push(`Overall: ${overall}`);
  return { text: L.join('\n'), overall };
}

module.exports = {
  PREVIEW_LABEL, PINNED_LABEL,
  loadOnboarded, idleMillis, queryRepository, discover, capacity, cleanupPlan, renderSummary,
};
