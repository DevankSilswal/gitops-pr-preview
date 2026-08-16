// Whether a pull request may have an environment, and what that environment is
// allowed to be.
//
// Pure functions: the caller supplies the policy, the current census and the
// pull request. Nothing here reads a database or a cluster, which is what makes
// the refusal paths — capacity full, fork denied, repository disabled —
// reachable in a test rather than only in production at an awkward moment.
'use strict';

const { occupiesCapacity } = require('./preview-state.js');

/**
 * The effective policy, and which parts of it the platform overrode.
 *
 * A project may ask for twenty environments on a node that permits eight in
 * total. Storing the request and reporting the effective value is honest;
 * silently accepting a number that can never be honoured is not, and a UI that
 * shows the requested number would be lying on the platform's behalf.
 */
function effectivePolicy(projectPolicy, platformLimits) {
  const capped = [];
  const out = { ...projectPolicy };

  if (projectPolicy.max_environments > platformLimits.maxEnvironments) {
    capped.push({
      field: 'max_environments',
      requested: projectPolicy.max_environments,
      effective: platformLimits.maxEnvironments,
      reason: 'the platform-wide cap is shared by every project on this node',
    });
    out.max_environments = platformLimits.maxEnvironments;
  }

  if (platformLimits.maxTtlDays && projectPolicy.ttl_days > platformLimits.maxTtlDays) {
    capped.push({
      field: 'ttl_days',
      requested: projectPolicy.ttl_days,
      effective: platformLimits.maxTtlDays,
      reason: 'the platform caps how long an idle environment may hold capacity',
    });
    out.ttl_days = platformLimits.maxTtlDays;
  }

  // Private previews cannot be honoured on a cluster with no secret salt: the
  // password is derived from it, so without one there is nothing to check
  // against. Reporting the environment as private anyway would be the worst
  // possible failure — a reviewer believing unreleased work is protected when
  // anyone with the link can open it.
  if (projectPolicy.visibility === 'private' && !platformLimits.privatePreviewsAvailable) {
    capped.push({
      field: 'visibility',
      requested: 'private',
      effective: 'public',
      reason: 'this cluster has no preview secret salt, so no password can be derived; every preview is reachable by anyone with the URL',
    });
    out.visibility = 'public';
  }

  return { policy: out, capped };
}

/** How many environments are in use, counted the way the node experiences it. */
function census(previews) {
  const live = previews.filter((p) => occupiesCapacity(p.status));
  return {
    used: live.length,
    pinned: live.filter((p) => p.lifecycle === 'pinned').length,
    byStatus: live.reduce((acc, p) => ({ ...acc, [p.status]: (acc[p.status] || 0) + 1 }), {}),
  };
}

/**
 * May this pull request have an environment?
 *
 * `unknownRepositories` is not decoration. If the platform could not list a
 * repository's pull requests, it does not know how many environments that
 * repository is holding, and admitting one more could exceed the node's cap
 * without anything noticing. Refusing while the census is incomplete is the
 * conservative direction, and the reason is reported rather than hidden.
 */
function admit({ pullRequest, repository, policy, platformLimits, census: c, unknownRepositories = 0 }) {
  const deny = (code, message) => ({ admit: false, code, message });

  if (!repository.enabled) {
    return deny('repository_disabled', 'Previews are turned off for this repository.');
  }

  if (pullRequest.isFork) {
    if (policy.fork_policy === 'deny') {
      return deny('fork_denied',
        'This project does not create previews for pull requests from forks.');
    }
    if (policy.fork_policy === 'approve' && !pullRequest.approvedForPreview) {
      return deny('fork_needs_approval',
        'This pull request comes from a fork. A maintainer has to approve it before an environment is created, because building it would run unreviewed code on this cluster.');
    }
  }

  if (pullRequest.isBot) {
    return deny('bot_author',
      'Dependency updates do not get an environment automatically. Add the preview label by hand if this one needs somewhere to click.');
  }

  if (unknownRepositories > 0) {
    return deny('census_incomplete',
      `${unknownRepositories} repository/repositories could not be reached, so the platform cannot tell how many environments are in use. No preview is created while the count is unknown.`);
  }

  const max = Math.min(policy.max_environments, platformLimits.maxEnvironments);
  if (c.used >= max) {
    return deny('capacity_full',
      `No environment was free: ${c.used} of ${max} are in use across every connected repository.`);
  }

  return { admit: true, code: 'admitted', message: `${c.used + 1} of ${max} environments in use after this one.` };
}

/** When an environment should expire, given when its pull request last moved. */
function expiresAt(lastActivityIso, ttlDays, now = Date.now()) {
  const t = Date.parse(lastActivityIso);
  // Unreadable metadata is not old. A preview is never expired because its
  // timestamp would not parse — the same rule the platform lifecycle already
  // holds itself to.
  if (Number.isNaN(t) || t > now) return null;
  return new Date(t + ttlDays * 86400000).toISOString();
}

module.exports = { effectivePolicy, census, admit, expiresAt };
