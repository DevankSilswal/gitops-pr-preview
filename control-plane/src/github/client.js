// The GitHub side of the orchestrator.
//
// Labels are the lifecycle API: adding `preview` is how an environment is
// asked for, removing it is how it is released, and the ApplicationSet does the
// rest. That indirection is deliberate (ADR 0002) and this client is
// deliberately small because of it — there is no "create namespace" here to get
// wrong.
//
// Authentication is the `gh` CLI's, which is how this repository is already
// operated. A GitHub App installation token replaces this in the stage that
// builds the App; the interface below is what that swap has to satisfy.
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

class GitHubCliClient {
  constructor({ gh = 'gh', timeoutMs = 20000 } = {}) {
    this.gh = gh;
    this.timeoutMs = timeoutMs;
  }

  async #api(args) {
    try {
      const { stdout } = await run(this.gh, ['api', ...args], { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      return stdout ? JSON.parse(stdout) : null;
    } catch (err) {
      const text = String(err.stderr || err.message);
      const status = /HTTP (\d{3})/.exec(text);
      const e = new Error(text.trim());
      e.status = status ? Number(status[1]) : undefined;
      throw e;
    }
  }

  async addLabel({ owner, repo, prNumber, label }) {
    return this.#api(['-X', 'POST', `repos/${owner}/${repo}/issues/${prNumber}/labels`,
      '-f', `labels[]=${label}`]);
  }

  async removeLabel({ owner, repo, prNumber, label }) {
    try {
      return await this.#api(['-X', 'DELETE', `repos/${owner}/${repo}/issues/${prNumber}/labels/${label}`]);
    } catch (err) {
      // Already absent is the desired state, reached by another route. A
      // cleanup that cannot run twice cannot be trusted once.
      if (err.status === 404) return { alreadyAbsent: true };
      throw err;
    }
  }

  async getPullRequest({ owner, repo, prNumber }) {
    const pr = await this.#api([`repos/${owner}/${repo}/pulls/${prNumber}`]);
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

  /**
   * One comment per preview, edited in place.
   *
   * Marker-based rather than "the most recent comment by the bot": a reviewer
   * commenting in between must not cause a second status comment, and a pull
   * request with thirty pushes must not have thirty of them.
   */
  async upsertPreviewComment({ owner, repo, prNumber, body, marker = '<!-- stackpreview -->' }) {
    const comments = await this.#api([`repos/${owner}/${repo}/issues/${prNumber}/comments`, '--paginate']);
    const existing = (comments || []).find((c) => typeof c.body === 'string' && c.body.includes(marker));
    const payload = `${marker}\n${body}`;
    if (existing) {
      await this.#api(['-X', 'PATCH', `repos/${owner}/${repo}/issues/comments/${existing.id}`, '-f', `body=${payload}`]);
      return { updated: true, id: existing.id };
    }
    const created = await this.#api(['-X', 'POST', `repos/${owner}/${repo}/issues/${prNumber}/comments`, '-f', `body=${payload}`]);
    return { updated: false, id: created && created.id };
  }
}

module.exports = { GitHubCliClient };
