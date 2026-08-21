// The HTTP layer.
//
// Thin on purpose: parse, authenticate, authorize, call a service, serialise.
// No business rule lives here, because a rule in a handler is a rule the
// webhook path and the sweep do not get.
//
// Two things this deliberately does not have: a route that accepts a Kubernetes
// manifest, and a route that creates a preview. A preview exists because a pull
// request exists; one created by hand would have no lifecycle and nothing to
// clean it up.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('../auth/authorize.js');
const webhook = require('../github/webhook.js');
const { SessionService } = require('../auth/session.js');
const { OAuthService } = require('../auth/oauth.js');

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

const fail = (res, status, code, message, detail) =>
  json(res, status, { error: { code, message, ...(detail ? { detail } : {}) } });

/** Read the body as bytes. The webhook signature is computed over these exact bytes. */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createServer({ store, previews, audit, orchestrator, cluster, platformLimits,
                       webhookSecret, sessions, oauth, sessionFor }) {
  const DASHBOARD = path.join(__dirname, '..', 'dashboard');

  // The dashboard is static and tiny. Serving it from the control plane keeps
  // the product one process and one origin, which is also why the session
  // cookie can be SameSite=Lax rather than something looser.
  const serveFile = (res, file, type) => {
    try {
      const body = fs.readFileSync(path.join(DASHBOARD, file));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      fail(res, 404, 'not_found', 'no such file');
    }
  };

  // Resolve the caller from the signed session cookie unless the caller
  // supplied their own resolver, which the tests do.
  const resolveSession = sessionFor || ((req) =>
    (sessions ? sessions.resolve(SessionService.parse(req.headers.cookie)) : null));
  /** Resolve the caller. Never trusts a header that names a role. */
  const actorFrom = (req) => {
    const session = resolveSession(req);
    return session ? store.actorFor(session.userId) : null;
  };

  const orgOfProject = (projectId) => {
    const project = store.getProject(projectId);
    return project ? { project, organizationId: project.organization_id } : null;
  };

  const orgOfPreview = (previewId) => {
    const preview = store.getPreview(previewId);
    if (!preview) return null;
    const repository = store.getRepository(preview.repository_id);
    const project = store.getProject(repository.project_id);
    return { preview, repository, project, organizationId: project.organization_id };
  };

  /** The product's own view of a preview. No Kubernetes nouns cross this line. */
  const present = (p, extra = {}) => ({
    id: p.id,
    status: p.status,
    statusText: require('../domain/preview-state.js').HUMAN[p.status] ?? p.status,
    reason: p.status_reason,
    observedAt: p.status_observed_at,
    url: p.url,
    pullRequest: { number: p.pr_number, title: p.pr_title, author: p.pr_author },
    repository: p.owner && p.repo_name ? `${p.owner}/${p.repo_name}` : undefined,
    lifecycle: p.lifecycle,
    createdAt: p.created_at,
    readyAt: p.ready_at,
    expiresAt: p.expires_at,
    ...extra,
  });

  const routes = [
    ['GET', /^\/api\/health$/, async (req, res) => json(res, 200, { status: 'ok' })],

    // --- the dashboard ------------------------------------------------------
    ['GET', /^\/$/, async (req, res) => serveFile(res, 'index.html', 'text/html; charset=utf-8')],
    ['GET', /^\/dashboard\/app\.js$/, async (req, res) => serveFile(res, 'app.js', 'text/javascript; charset=utf-8')],

    // --- sign in ------------------------------------------------------------
    ['GET', /^\/auth\/github$/, async (req, res) => {
      if (!oauth) {
        return fail(res, 501, 'oauth_not_configured',
          'GitHub sign-in is not set up on this installation. See docs/product/dashboard-access.md.');
      }
      const { url, cookie } = oauth.begin();
      res.writeHead(302, { location: url, 'set-cookie': cookie });
      res.end();
    }],

    ['GET', /^\/auth\/github\/callback$/, async (req, res) => {
      if (!oauth) return fail(res, 501, 'oauth_not_configured', 'GitHub sign-in is not set up');
      const url = new URL(req.url, 'http://localhost');
      const expected = OAuthService.readState(req.headers.cookie);

      // A callback whose state does not match the cookie is either a stale tab
      // or somebody trying to sign this browser into an account it did not ask
      // for. Neither deserves a session.
      if (!OAuthService.stateMatches(url.searchParams.get('state'), expected)) {
        return fail(res, 400, 'bad_state', 'this sign-in did not start here; try again');
      }
      const code = url.searchParams.get('code');
      if (!code) return fail(res, 400, 'missing_code', 'GitHub did not return an authorization code');

      let identity;
      try {
        identity = await oauth.identify(code);
      } catch (err) {
        console.error(JSON.stringify({ level: 'warn', message: 'oauth exchange failed', error: String(err.message) }));
        return fail(res, 502, 'oauth_failed', 'GitHub would not complete the sign-in');
      }

      const user = store.upsertUser(identity);
      const session = sessions.issue(user.id);
      audit.record({ actorUserId: user.id, action: 'user.signed_in', subjectType: 'user', subjectId: user.id });
      res.writeHead(302, {
        location: '/',
        'set-cookie': [oauth.clearStateCookie(), sessions.cookie(session.value)],
      });
      res.end();
    }],

    ['GET', /^\/auth\/logout$/, async (req, res) => {
      const cookie = SessionService.parse(req.headers.cookie);
      if (cookie && sessions) sessions.revoke(cookie);
      res.writeHead(302, { location: '/', 'set-cookie': sessions ? sessions.clearCookie() : '' });
      res.end();
    }],

    ['GET', /^\/api\/me$/, async (req, res) => {
      const session = resolveSession(req);
      if (!session) return fail(res, 401, 'unauthenticated', 'sign in to continue');
      const user = store.getUser(session.userId);
      if (!user) return fail(res, 401, 'unauthenticated', 'sign in to continue');
      const actor = store.actorFor(user.id);
      return json(res, 200, {
        user: { id: user.id, login: user.login, avatarUrl: user.avatar_url },
        // Roles are reported so the dashboard can hide what it should, which is
        // a courtesy. Every one of them is enforced again on the server.
        organizations: actor.roleByOrg,
      });
    }],

    ['POST', /^\/api\/webhooks\/github$/, async (req, res) => {
      const rawBody = await readBody(req);
      const result = await webhook.receive({
        rawBody, headers: req.headers, secret: webhookSecret, store,
        process: async (intent) => {
          switch (intent.intent) {
            case 'create_preview': return previews.onPullRequestOpened(intent);
            case 'update_preview': return previews.onPullRequestUpdated(intent);
            case 'destroy_preview': return previews.onPullRequestClosed(intent);
            default: return { outcome: 'ignored' };
          }
        },
      });
      return json(res, result.status, result.body);
    }],

    ['GET', /^\/api\/projects$/, async (req, res) => {
      const actor = actorFrom(req);
      if (!actor) return fail(res, 401, 'unauthenticated', 'sign in to continue');
      const projects = store.listProjects(auth.visibleOrganizations(actor));
      return json(res, 200, { projects });
    }],

    ['GET', /^\/api\/projects\/([^/]+)$/, async (req, res, [projectId]) => {
      const actor = actorFrom(req);
      const ctx = orgOfProject(projectId);
      if (!ctx) return fail(res, 404, 'not_found', 'no such project');
      auth.authorize(actor, 'project.view', ctx);
      return json(res, 200, {
        project: ctx.project,
        repositories: store.listRepositories(projectId),
        previews: store.listPreviewsForProject(projectId).map((p) => present(p)),
      });
    }],

    ['GET', /^\/api\/projects\/([^/]+)\/policies$/, async (req, res, [projectId]) => {
      const actor = actorFrom(req);
      const ctx = orgOfProject(projectId);
      if (!ctx) return fail(res, 404, 'not_found', 'no such project');
      auth.authorize(actor, 'policy.view', ctx);
      const { effectivePolicy } = require('../domain/policy.js');
      const { policy, capped } = effectivePolicy(store.getPolicy(projectId), platformLimits);
      return json(res, 200, { policy, capped });
    }],

    ['PUT', /^\/api\/projects\/([^/]+)\/policies$/, async (req, res, [projectId]) => {
      const actor = actorFrom(req);
      const ctx = orgOfProject(projectId);
      if (!ctx) return fail(res, 404, 'not_found', 'no such project');
      auth.authorize(actor, 'policy.update', ctx);
      const patch = JSON.parse((await readBody(req)).toString() || '{}');
      const updated = store.updatePolicy(projectId, patch, actor.userId);
      audit.record({ organizationId: ctx.organizationId, projectId, actorUserId: actor.userId,
        action: 'policy.updated', subjectType: 'policy', subjectId: updated.id, detail: patch });
      return json(res, 200, { policy: updated });
    }],

    ['GET', /^\/api\/previews$/, async (req, res) => {
      const actor = actorFrom(req);
      if (!actor) return fail(res, 401, 'unauthenticated', 'sign in to continue');
      const orgs = new Set(auth.visibleOrganizations(actor));
      const rows = store.listLivePreviews().filter((p) => {
        const project = store.getProject(p.project_id);
        return project && orgs.has(project.organization_id);
      });
      return json(res, 200, { previews: rows.map((p) => present(p)) });
    }],

    ['GET', /^\/api\/previews\/([^/]+)$/, async (req, res, [previewId]) => {
      const actor = actorFrom(req);
      const ctx = orgOfPreview(previewId);
      if (!ctx) return fail(res, 404, 'not_found', 'no such preview');
      auth.authorize(actor, 'preview.view', ctx);
      // Reconciling on read is what stops the page showing a stale READY: a row
      // is corrected by somebody looking at it.
      await previews.reconcile(previewId).catch(() => {});
      const fresh = store.getPreview(previewId);
      return json(res, 200, {
        preview: present({ ...fresh, owner: ctx.repository.owner, repo_name: ctx.repository.name }),
        deployments: store.listDeployments(previewId),
      });
    }],

    ['POST', /^\/api\/previews\/([^/]+)\/redeploy$/, async (req, res, [previewId]) => {
      const actor = actorFrom(req);
      const ctx = orgOfPreview(previewId);
      if (!ctx) return fail(res, 404, 'not_found', 'no such preview');
      auth.authorize(actor, 'preview.redeploy', ctx);
      const updated = await previews.redeploy(previewId, actor.userId);
      return json(res, 202, { preview: present(updated) });
    }],

    ['POST', /^\/api\/previews\/([^/]+)\/rollback$/, async (req, res, [previewId]) => {
      const actor = actorFrom(req);
      const ctx = orgOfPreview(previewId);
      if (!ctx) return fail(res, 404, 'not_found', 'no such preview');
      auth.authorize(actor, 'preview.rollback', ctx);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const updated = await previews.rollback(previewId, actor.userId, body.deployment_id ?? null);
      return json(res, 202, { preview: present(updated) });
    }],

    ['DELETE', /^\/api\/previews\/([^/]+)$/, async (req, res, [previewId]) => {
      const actor = actorFrom(req);
      const ctx = orgOfPreview(previewId);
      if (!ctx) return fail(res, 404, 'not_found', 'no such preview');
      auth.authorize(actor, 'preview.destroy', ctx);
      const result = await previews.destroy(previewId, actor.userId, 'destroyed from the dashboard');
      if (result.outcome === 'refused') return fail(res, 409, 'pinned', result.reason);
      return json(res, 202, { outcome: result.outcome });
    }],

    ['GET', /^\/api\/previews\/([^/]+)\/logs$/, async (req, res, [previewId]) => {
      const actor = actorFrom(req);
      const ctx = orgOfPreview(previewId);
      if (!ctx) return fail(res, 404, 'not_found', 'no such preview');
      // Deliberately a stronger permission than viewing the running application.
      auth.authorize(actor, 'preview.logs', ctx);
      const lines = await orchestrator.logs({ slug: ctx.project.slug, prNumber: ctx.preview.pr_number });
      return json(res, 200, { lines });
    }],

    ['GET', /^\/api\/platform\/health$/, async (req, res) => {
      const actor = actorFrom(req);
      if (!actor) return fail(res, 401, 'unauthenticated', 'sign in to continue');
      try {
        return json(res, 200, await cluster.platformHealth());
      } catch (err) {
        // A cluster that cannot be reached is reported as unknown, never as healthy.
        return json(res, 200, { status: 'unknown', error: String(err.message) });
      }
    }],

    ['GET', /^\/api\/platform\/capacity$/, async (req, res) => {
      const actor = actorFrom(req);
      if (!actor) return fail(res, 401, 'unauthenticated', 'sign in to continue');
      const { census } = require('../domain/policy.js');
      const c = census(store.listLivePreviews());
      return json(res, 200, { ...c, max: platformLimits.maxEnvironments,
        remaining: Math.max(0, platformLimits.maxEnvironments - c.used),
        unknownRepositories: platformLimits.unknownRepositories ?? 0 });
    }],

    ['GET', /^\/api\/audit$/, async (req, res) => {
      const actor = actorFrom(req);
      if (!actor) return fail(res, 401, 'unauthenticated', 'sign in to continue');
      const orgs = auth.visibleOrganizations(actor);
      const events = orgs.flatMap((o) => (auth.can(actor, 'audit.view', { organizationId: o }) ? audit.list(o, 100) : []));
      return json(res, 200, { events });
    }],
  ];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      for (const [method, pattern, handler] of routes) {
        if (req.method !== method) continue;
        const match = url.pathname.match(pattern);
        if (!match) continue;
        return await handler(req, res, match.slice(1));
      }
      return fail(res, 404, 'not_found', 'no such endpoint');
    } catch (err) {
      if (err instanceof auth.Unauthenticated) return fail(res, 401, 'unauthenticated', 'sign in to continue');
      if (err instanceof auth.Forbidden) return fail(res, 403, 'forbidden', 'you do not have permission to do that');
      // Never echo an internal message to a caller; it is in the log, once.
      console.error(JSON.stringify({ level: 'error', path: url.pathname, message: String(err.message) }));
      return fail(res, 500, 'internal_error', 'something went wrong');
    }
  });
}

module.exports = { createServer };
