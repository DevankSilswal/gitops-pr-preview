// GitHub App authentication.
//
// The App's private key never talks to the API directly. It signs a short-lived
// JWT, the JWT buys an installation token, and the installation token — scoped
// to one installation, valid for an hour — is what every request carries. That
// indirection is the entire security value of a GitHub App over a personal
// token: the credential in the cluster cannot act outside the repositories the
// App was installed on, and it expires on its own.
//
// Replaces GitHubCliClient, which authenticated as a human being and could
// therefore do anything that human could.
'use strict';

const crypto = require('node:crypto');

/**
 * A JWT for the App itself. Ten minutes is GitHub's maximum; the clock skew
 * allowance is theirs too — an `iat` in the future is rejected outright, and
 * cluster clocks drift.
 */
function appJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: String(appId) };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

class GitHubAppClient {
  /**
   * @param {object} deps
   * @param {string|number} deps.appId
   * @param {string} deps.privateKey PEM
   * @param {function} [deps.fetchImpl] injected for tests
   */
  constructor({ appId, privateKey, fetchImpl = fetch, api = 'https://api.github.com' }) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.fetch = fetchImpl;
    this.api = api;
    // Installation tokens last an hour. Caching them is not an optimisation —
    // minting one per request would burn the App's rate limit on authentication.
    this.tokens = new Map();
  }

  async #request(path, { token, method = 'GET', body } = {}) {
    const res = await this.fetch(`${this.api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'stackpreview',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204 || res.status === 404) return { status: res.status, data: null };
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} → ${res.status}: ${data && data.message}`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, data };
  }

  async installationToken(installationId) {
    const cached = this.tokens.get(installationId);
    // Refreshed with five minutes to spare: a token that expires mid-request is
    // an error that only appears under load.
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;

    const jwt = appJwt({ appId: this.appId, privateKey: this.privateKey });
    const { data } = await this.#request(`/app/installations/${installationId}/access_tokens`,
      { token: jwt, method: 'POST' });
    const entry = { token: data.token, expiresAt: Date.parse(data.expires_at) };
    this.tokens.set(installationId, entry);
    return entry.token;
  }

  /** The interface ArgoCDOrchestrator already expects, installation-scoped. */
  forInstallation(installationId) {
    const call = async (path, opts) =>
      this.#request(path, { ...opts, token: await this.installationToken(installationId) });

    return {
      async addLabel({ owner, repo, prNumber, label }) {
        return call(`/repos/${owner}/${repo}/issues/${prNumber}/labels`,
          { method: 'POST', body: { labels: [label] } });
      },
      async removeLabel({ owner, repo, prNumber, label }) {
        const res = await call(`/repos/${owner}/${repo}/issues/${prNumber}/labels/${label}`, { method: 'DELETE' });
        // Already absent is the desired state reached another way.
        return res.status === 404 ? { alreadyAbsent: true } : res.data;
      },
      async getPullRequest({ owner, repo, prNumber }) {
        const { data: pr } = await call(`/repos/${owner}/${repo}/pulls/${prNumber}`);
        return {
          number: pr.number, title: pr.title, author: pr.user && pr.user.login,
          headSha: pr.head && pr.head.sha, updatedAt: pr.updated_at, state: pr.state,
          labels: (pr.labels || []).map((l) => l.name),
          isFork: pr.head && pr.head.repo && pr.head.repo.full_name !== `${owner}/${repo}`,
        };
      },
      /**
       * One comment per preview, edited in place — found by a marker rather
       * than by "the last comment from us", so a reviewer commenting in between
       * does not produce a second one and thirty pushes do not produce thirty.
       */
      async upsertPreviewComment({ owner, repo, prNumber, body, marker = '<!-- stackpreview -->' }) {
        const { data: comments } = await call(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);
        const existing = (comments || []).find((c) => typeof c.body === 'string' && c.body.includes(marker));
        const payload = `${marker}\n${body}`;
        if (existing) {
          await call(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body: payload } });
          return { updated: true, id: existing.id };
        }
        const { data } = await call(`/repos/${owner}/${repo}/issues/${prNumber}/comments`,
          { method: 'POST', body: { body: payload } });
        return { updated: false, id: data && data.id };
      },
    };
  }
}

module.exports = { GitHubAppClient, appJwt };
