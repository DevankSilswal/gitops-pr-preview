-- The product's own state. Not a mirror of the cluster.
--
-- Kubernetes owns whether a pod is running and GitHub owns whether a pull
-- request is open. This database owns what was decided, by whom, and what was
-- observed when — the things neither of those systems will remember.
--
-- Every status column here is an observation with a timestamp beside it, never
-- an authority. The moment a row is treated as the truth about the cluster it
-- becomes a cache that is wrong during exactly the incident it was needed for.

PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  github_login  TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  github_id     INTEGER NOT NULL UNIQUE,
  login         TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE memberships (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('owner','admin','developer','viewer')),
  created_at       TEXT NOT NULL,
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  -- Immutable. It prefixes every namespace and every hostname, so renaming it
  -- would orphan running environments whose namespaces no longer match.
  slug             TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL,
  archived_at      TEXT
);
CREATE INDEX idx_projects_org ON projects(organization_id);

CREATE TABLE repositories (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner             TEXT NOT NULL,
  name              TEXT NOT NULL,
  default_branch    TEXT NOT NULL DEFAULT 'main',
  installation_id   INTEGER,
  image_repository  TEXT NOT NULL,
  service_port      INTEGER NOT NULL DEFAULT 3000,
  health_path       TEXT NOT NULL DEFAULT '/api/health',
  enabled           INTEGER NOT NULL DEFAULT 1,
  connected_at      TEXT NOT NULL,
  -- A repository belongs to exactly one project. Two projects serving the same
  -- repository would race to create the same namespace.
  UNIQUE (owner, name)
);
CREATE INDEX idx_repositories_project ON repositories(project_id);

CREATE TABLE policies (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  ttl_days          INTEGER NOT NULL DEFAULT 3,
  max_environments  INTEGER NOT NULL DEFAULT 8,
  cpu_limit         TEXT NOT NULL DEFAULT '500m',
  memory_limit      TEXT NOT NULL DEFAULT '512Mi',
  visibility        TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  database_enabled  INTEGER NOT NULL DEFAULT 0,
  fork_policy       TEXT NOT NULL DEFAULT 'approve' CHECK (fork_policy IN ('deny','approve','allow')),
  updated_at        TEXT NOT NULL,
  updated_by        TEXT REFERENCES users(id)
);

CREATE TABLE previews (
  id                  TEXT PRIMARY KEY,
  repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_number           INTEGER NOT NULL,
  pr_title            TEXT,
  pr_author           TEXT,
  status              TEXT NOT NULL,
  -- Why, in language a developer can act on. Never a raw Kubernetes message.
  status_reason       TEXT,
  status_observed_at  TEXT NOT NULL,
  url                 TEXT,
  namespace           TEXT,
  lifecycle           TEXT NOT NULL DEFAULT 'ephemeral' CHECK (lifecycle IN ('ephemeral','pinned')),
  created_at          TEXT NOT NULL,
  ready_at            TEXT,
  expires_at          TEXT,
  destroyed_at        TEXT,
  -- Pull request #1 exists in every repository ever created.
  UNIQUE (repository_id, pr_number)
);
CREATE INDEX idx_previews_status ON previews(status);
CREATE INDEX idx_previews_created ON previews(created_at DESC);
-- The sweep only ever looks at live rows, and this table only grows.
CREATE INDEX idx_previews_expiry ON previews(expires_at) WHERE destroyed_at IS NULL;

CREATE TABLE deployments (
  id                    TEXT PRIMARY KEY,
  preview_id            TEXT NOT NULL REFERENCES previews(id) ON DELETE CASCADE,
  commit_sha            TEXT NOT NULL,
  image_tag             TEXT,
  trigger               TEXT NOT NULL CHECK (trigger IN ('open','synchronize','redeploy','rollback')),
  status                TEXT NOT NULL CHECK (status IN ('pending','building','deploying','succeeded','failed')),
  -- A closed set, so the UI can translate rather than print Kubernetes at a
  -- developer. The raw text lives in failure_detail underneath.
  failure_kind          TEXT CHECK (failure_kind IN ('build','image','health','policy','capacity','unknown')),
  failure_detail        TEXT,
  provisioning_seconds  INTEGER,
  started_at            TEXT NOT NULL,
  finished_at           TEXT,
  is_last_known_good    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_deployments_preview ON deployments(preview_id, started_at DESC);
CREATE INDEX idx_deployments_good ON deployments(preview_id, is_last_known_good);

CREATE TABLE audit_events (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  -- NULL means the system acted. TTL expiry has no human behind it, and
  -- inventing one would be a lie in the record that exists to be trusted.
  actor_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  action           TEXT NOT NULL,
  subject_type     TEXT NOT NULL,
  subject_id       TEXT,
  detail_json      TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_audit_org ON audit_events(organization_id, created_at DESC);
CREATE INDEX idx_audit_project ON audit_events(project_id, created_at DESC);

CREATE TABLE webhook_events (
  id             TEXT PRIMARY KEY,
  -- X-GitHub-Delivery. The uniqueness constraint *is* the retry protection:
  -- GitHub redelivers, the second insert conflicts, and no second preview is
  -- created.
  delivery_id    TEXT NOT NULL UNIQUE,
  event_type     TEXT NOT NULL,
  repository_id  TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  received_at    TEXT NOT NULL,
  processed_at   TEXT,
  result         TEXT CHECK (result IN ('ok','ignored','failed')),
  error          TEXT
);
CREATE INDEX idx_webhook_unprocessed ON webhook_events(received_at) WHERE processed_at IS NULL;

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
