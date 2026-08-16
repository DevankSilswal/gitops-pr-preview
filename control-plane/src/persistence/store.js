// Data access. Every query in the product lives here.
//
// No SQL leaks into a handler or a service, which is what makes ADR 0014's
// "moving to Postgres later is a new implementation of this interface, not a
// rewrite" true rather than aspirational.
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const nowIso = () => new Date().toISOString();

function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') {
    // WAL is what makes a single-writer file database comfortable with readers
    // during a write. On :memory: it is meaningless and sqlite ignores it.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  return db;
}

/** Forward-only, numbered, in a transaction, recorded. Same shape as the preview database's migrations. */
function migrate(db, dir = path.join(__dirname, '..', '..', 'migrations')) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, nowIso());
      db.exec('COMMIT');
      ran.push(file);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
  return ran;
}

function createStore(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null;
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  return {
    db,

    // --- organizations, users, membership -----------------------------------
    createOrganization({ name, githubLogin }) {
      const row = { id: id('org'), name, github_login: githubLogin, created_at: nowIso() };
      run('INSERT INTO organizations (id,name,github_login,created_at) VALUES (?,?,?,?)',
        row.id, row.name, row.github_login, row.created_at);
      return row;
    },
    upsertUser({ githubId, login, avatarUrl }) {
      const existing = one('SELECT * FROM users WHERE github_id = ?', githubId);
      if (existing) {
        run('UPDATE users SET login = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?',
          login, avatarUrl ?? null, nowIso(), existing.id);
        return { ...existing, login };
      }
      const row = { id: id('usr'), github_id: githubId, login, avatar_url: avatarUrl ?? null, created_at: nowIso(), last_seen_at: nowIso() };
      run('INSERT INTO users (id,github_id,login,avatar_url,created_at,last_seen_at) VALUES (?,?,?,?,?,?)',
        row.id, row.github_id, row.login, row.avatar_url, row.created_at, row.last_seen_at);
      return row;
    },
    addMembership({ organizationId, userId, role }) {
      const row = { id: id('mem'), organization_id: organizationId, user_id: userId, role, created_at: nowIso() };
      run('INSERT INTO memberships (id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,?)',
        row.id, row.organization_id, row.user_id, row.role, row.created_at);
      return row;
    },
    /** The actor shape the authorization layer expects. One query, every request. */
    actorFor(userId) {
      const rows = all('SELECT organization_id, role FROM memberships WHERE user_id = ?', userId);
      if (!rows.length) return { userId, roleByOrg: {} };
      return { userId, roleByOrg: Object.fromEntries(rows.map((r) => [r.organization_id, r.role])) };
    },

    // --- projects, repositories, policy --------------------------------------
    createProject({ organizationId, name, slug }) {
      const row = { id: id('prj'), organization_id: organizationId, name, slug, created_at: nowIso(), archived_at: null };
      run('INSERT INTO projects (id,organization_id,name,slug,created_at) VALUES (?,?,?,?,?)',
        row.id, row.organization_id, row.name, row.slug, row.created_at);
      // Every project has a policy from the moment it exists, so nothing has to
      // handle "no policy yet" — the state that produces an unbounded TTL.
      run('INSERT INTO policies (id,project_id,updated_at) VALUES (?,?,?)', id('pol'), row.id, nowIso());
      return row;
    },
    getProject: (projectId) => one('SELECT * FROM projects WHERE id = ?', projectId),
    listProjects: (orgIds) => (orgIds.length
      ? all(`SELECT * FROM projects WHERE organization_id IN (${orgIds.map(() => '?').join(',')}) AND archived_at IS NULL ORDER BY created_at DESC`, ...orgIds)
      : []),

    connectRepository({ projectId, owner, name, imageRepository, servicePort, healthPath, installationId }) {
      const row = {
        id: id('rep'), project_id: projectId, owner, name,
        image_repository: imageRepository, service_port: servicePort ?? 3000,
        health_path: healthPath ?? '/api/health', installation_id: installationId ?? null,
        enabled: 1, connected_at: nowIso(),
      };
      run(`INSERT INTO repositories (id,project_id,owner,name,image_repository,service_port,health_path,installation_id,enabled,connected_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        row.id, row.project_id, row.owner, row.name, row.image_repository,
        row.service_port, row.health_path, row.installation_id, row.enabled, row.connected_at);
      return row;
    },
    getRepository: (repoId) => one('SELECT * FROM repositories WHERE id = ?', repoId),
    findRepository: (owner, name) => one('SELECT * FROM repositories WHERE owner = ? AND name = ?', owner, name),
    listRepositories: (projectId) => all('SELECT * FROM repositories WHERE project_id = ? ORDER BY connected_at', projectId),
    setRepositoryEnabled: (repoId, enabled) => run('UPDATE repositories SET enabled = ? WHERE id = ?', enabled ? 1 : 0, repoId),

    getPolicy: (projectId) => one('SELECT * FROM policies WHERE project_id = ?', projectId),
    updatePolicy(projectId, patch, actorUserId) {
      const allowed = ['ttl_days', 'max_environments', 'cpu_limit', 'memory_limit', 'visibility', 'database_enabled', 'fork_policy'];
      const fields = Object.keys(patch).filter((k) => allowed.includes(k));
      if (!fields.length) return this.getPolicy(projectId);
      const set = fields.map((f) => `${f} = ?`).join(', ');
      run(`UPDATE policies SET ${set}, updated_at = ?, updated_by = ? WHERE project_id = ?`,
        ...fields.map((f) => patch[f]), nowIso(), actorUserId ?? null, projectId);
      return this.getPolicy(projectId);
    },

    // --- previews and deployments --------------------------------------------
    createPreview({ repositoryId, prNumber, prTitle, prAuthor, status, statusReason, namespace, url, expiresAt }) {
      const row = {
        id: id('pv'), repository_id: repositoryId, pr_number: prNumber,
        pr_title: prTitle ?? null, pr_author: prAuthor ?? null,
        status, status_reason: statusReason ?? null, status_observed_at: nowIso(),
        url: url ?? null, namespace: namespace ?? null, lifecycle: 'ephemeral',
        created_at: nowIso(), ready_at: null, expires_at: expiresAt ?? null, destroyed_at: null,
      };
      run(`INSERT INTO previews (id,repository_id,pr_number,pr_title,pr_author,status,status_reason,
             status_observed_at,url,namespace,lifecycle,created_at,expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        row.id, row.repository_id, row.pr_number, row.pr_title, row.pr_author, row.status,
        row.status_reason, row.status_observed_at, row.url, row.namespace, row.lifecycle,
        row.created_at, row.expires_at);
      return row;
    },
    getPreview: (previewId) => one('SELECT * FROM previews WHERE id = ?', previewId),
    findPreview: (repositoryId, prNumber) => one('SELECT * FROM previews WHERE repository_id = ? AND pr_number = ?', repositoryId, prNumber),
    /** Everything that is not destroyed, for the census and the dashboard. */
    listLivePreviews: () => all(`SELECT p.*, r.owner, r.name AS repo_name, r.project_id
                                 FROM previews p JOIN repositories r ON r.id = p.repository_id
                                 WHERE p.destroyed_at IS NULL ORDER BY p.created_at DESC`),
    listPreviewsForProject: (projectId) => all(`SELECT p.*, r.owner, r.name AS repo_name
                                                FROM previews p JOIN repositories r ON r.id = p.repository_id
                                                WHERE r.project_id = ? ORDER BY p.created_at DESC`, projectId),
    updatePreviewStatus(previewId, { status, reason, url, readyAt, destroyedAt, expiresAt }) {
      const sets = ['status = ?', 'status_reason = ?', 'status_observed_at = ?'];
      const args = [status, reason ?? null, nowIso()];
      if (url !== undefined) { sets.push('url = ?'); args.push(url); }
      if (readyAt !== undefined) { sets.push('ready_at = ?'); args.push(readyAt); }
      if (destroyedAt !== undefined) { sets.push('destroyed_at = ?'); args.push(destroyedAt); }
      if (expiresAt !== undefined) { sets.push('expires_at = ?'); args.push(expiresAt); }
      args.push(previewId);
      run(`UPDATE previews SET ${sets.join(', ')} WHERE id = ?`, ...args);
      return this.getPreview(previewId);
    },
    setLifecycle: (previewId, lifecycle) => run('UPDATE previews SET lifecycle = ? WHERE id = ?', lifecycle, previewId),

    startDeployment({ previewId, commitSha, imageTag, trigger }) {
      const row = {
        id: id('dep'), preview_id: previewId, commit_sha: commitSha, image_tag: imageTag ?? null,
        trigger, status: 'pending', started_at: nowIso(),
      };
      run(`INSERT INTO deployments (id,preview_id,commit_sha,image_tag,trigger,status,started_at)
           VALUES (?,?,?,?,?,?,?)`,
        row.id, row.preview_id, row.commit_sha, row.image_tag, row.trigger, row.status, row.started_at);
      return row;
    },
    finishDeployment(deploymentId, { status, failureKind, failureDetail, provisioningSeconds }) {
      run(`UPDATE deployments SET status = ?, failure_kind = ?, failure_detail = ?,
             provisioning_seconds = ?, finished_at = ? WHERE id = ?`,
        status, failureKind ?? null, failureDetail ?? null, provisioningSeconds ?? null, nowIso(), deploymentId);
      if (status === 'succeeded') {
        const dep = one('SELECT preview_id FROM deployments WHERE id = ?', deploymentId);
        // Exactly one deployment per preview is the rollback target.
        run('UPDATE deployments SET is_last_known_good = 0 WHERE preview_id = ?', dep.preview_id);
        run('UPDATE deployments SET is_last_known_good = 1 WHERE id = ?', deploymentId);
      }
      return one('SELECT * FROM deployments WHERE id = ?', deploymentId);
    },
    listDeployments: (previewId) => all('SELECT * FROM deployments WHERE preview_id = ? ORDER BY started_at DESC', previewId),
    lastKnownGood: (previewId) => one('SELECT * FROM deployments WHERE preview_id = ? AND is_last_known_good = 1', previewId),
    currentDeployment: (previewId) => one('SELECT * FROM deployments WHERE preview_id = ? ORDER BY started_at DESC LIMIT 1', previewId),

    // --- audit ---------------------------------------------------------------
    recordAudit({ organizationId, projectId, actorUserId, action, subjectType, subjectId, detail }) {
      const row = {
        id: id('aud'), organization_id: organizationId ?? null, project_id: projectId ?? null,
        actor_user_id: actorUserId ?? null, action, subject_type: subjectType,
        subject_id: subjectId ?? null, detail_json: detail ? JSON.stringify(detail) : null,
        created_at: nowIso(),
      };
      run(`INSERT INTO audit_events (id,organization_id,project_id,actor_user_id,action,subject_type,subject_id,detail_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        row.id, row.organization_id, row.project_id, row.actor_user_id, row.action,
        row.subject_type, row.subject_id, row.detail_json, row.created_at);
      return row;
    },
    listAudit: (orgId, limit = 100) => all('SELECT * FROM audit_events WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?', orgId, limit),

    // --- webhook idempotency --------------------------------------------------
    recordWebhookEvent({ deliveryId, eventType, receivedAt }) {
      const row = { id: id('whk'), delivery_id: deliveryId, event_type: eventType, received_at: receivedAt };
      run('INSERT INTO webhook_events (id,delivery_id,event_type,received_at) VALUES (?,?,?,?)',
        row.id, row.delivery_id, row.event_type, row.received_at);
      return row;
    },
    completeWebhookEvent: (eventId, { result, error, processedAt }) =>
      run('UPDATE webhook_events SET result = ?, error = ?, processed_at = ? WHERE id = ?',
        result, error ?? null, processedAt, eventId),
    getWebhookEvent: (deliveryId) => one('SELECT * FROM webhook_events WHERE delivery_id = ?', deliveryId),
  };
}

module.exports = { open, migrate, createStore, id, nowIso };
