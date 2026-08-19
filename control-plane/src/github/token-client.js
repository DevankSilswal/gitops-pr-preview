// GitHub over HTTP with a personal access token.
//
// The alternative to the App, and honestly the weaker one: this credential is
// long-lived, scoped to an account rather than to an installation, and acts as
// the person who issued it — so preview comments appear under their name. It
// exists because creating a GitHub App requires a browser and an account, and a
// platform that cannot be brought up without one is a platform that stays on a
// laptop.
//
// The webhook side loses nothing. A repository webhook is signed with the same
// HMAC the App would use, so signature verification, idempotency and the whole
// delivery path are exercised for real either way.
//
// Same interface as GitHubAppClient. main.js picks one and nothing downstream
// knows which — swapping to the App later is a Secret and an env var.
'use strict';

const API = 'https://api.github.com';

class GitHubTokenClient {
  constructor({ token, userAgent = 'stackpreview' }) {
    if (!token) throw new Error('GitHubTokenClient needs a token');
    this.token = token;
    this.userAgent = userAgent;
  }

  async #request(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': this.userAgent,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      // The message carries the status and GitHub's own words, and never the
      // token — an error string is the most common way a credential reaches a
      // log.
      const err = new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  async addLabel({ owner, repo, prNumber, label }) {
    return this.#request('POST', `/repos/${owner}/${repo}/issues/${prNumber}/labels`, { labels: [label] });
  }

  async removeLabel({ owner, repo, prNumber, label }) {
    try {
      return await this.#request('DELETE', `/repos/${owner}/${repo}/issues/${prNumber}/labels/${label}`);
    } catch (err) {
      // Already absent is the desired state reached by another route.
      if (err.status === 404) return { alreadyAbsent: true };
      throw err;
    }
  }

  async getPullRequest({ owner, repo, prNumber }) {
    const pr = await this.#request('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`);
    return {
      number: pr.number,
      title: pr.title,
      author: pr.user && pr.user.login,
      headSha: pr.head && pr.head.sha,
      updatedAt: pr.updated_at,
      state: pr.state,
      labels: (pr.labels || []).map((l) => l.name),
      isFork: pr.head && pr.head.repo && pr.head.repo.full_name !== `${owner}/${repo}`,
    };
  }

  /** One comment per preview, edited in place — never one per push. */
  async upsertPreviewComment({ owner, repo, prNumber, body, marker = '<!-- stackpreview -->' }) {
    const comments = await this.#request('GET', `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);
    const existing = (comments || []).find((c) => typeof c.body === 'string' && c.body.includes(marker));
    const payload = `${marker}\n${body}`;
    if (existing) {
      await this.#request('PATCH', `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body: payload });
      return { updated: true, id: existing.id };
    }
    const created = await this.#request('POST', `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body: payload });
    return { updated: false, id: created && created.id };
  }

  /**
   * The App client returns a differently-scoped client per installation. A
   * token has no such notion — it is one credential with one scope — so this
   * returns itself and ignores the argument.
   *
   * That difference is the security trade in one method: with the App, a
   * compromised orchestrator can act only on the repositories that installation
   * covers; here it can act on everything the token can reach.
   */
  forInstallation() { return this; }

  /** Who this token is, for the startup line. Never prints the token. */
  async identify() {
    const me = await this.#request('GET', '/user');
    return { login: me.login, id: me.id };
  }
}

module.exports = { GitHubTokenClient };
