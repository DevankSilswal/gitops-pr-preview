# StackPreview — data model

The control-plane database holds **product** state: who exists, what they own,
what was requested, what happened and when. It is deliberately not a mirror of
the cluster. Kubernetes and GitHub are each the source of truth for their own
facts, and the moment this database starts holding a second opinion about
whether a pod is running, it becomes a cache that is wrong in an incident.

The rule: **rows record decisions and observations; live status is read from
the orchestrator.** `Preview.status` is the last observed state with the time it
was observed, not an authority.

Datastore is SQLite — see [ADR 0014](../decisions/0014-control-plane-datastore.md).

---

## ER diagram

```mermaid
erDiagram
    ORGANIZATION ||--o{ MEMBERSHIP : has
    ORGANIZATION ||--o{ PROJECT : owns
    USER        ||--o{ MEMBERSHIP : holds
    USER        ||--o{ AUDIT_EVENT : performs

    PROJECT     ||--o{ REPOSITORY : contains
    PROJECT     ||--|| POLICY : "governed by"
    PROJECT     ||--o{ AUDIT_EVENT : scopes

    REPOSITORY  ||--o{ PREVIEW : produces
    REPOSITORY  ||--o{ WEBHOOK_EVENT : receives

    PREVIEW     ||--o{ DEPLOYMENT : "has attempts"

    ORGANIZATION {
        text   id PK
        text   name
        text   github_login
        text   created_at
    }
    USER {
        text   id PK
        text   github_id UK
        text   login
        text   avatar_url
        text   created_at
        text   last_seen_at
    }
    MEMBERSHIP {
        text   id PK
        text   organization_id FK
        text   user_id FK
        text   role "owner|admin|developer|viewer"
        text   created_at
    }
    PROJECT {
        text   id PK
        text   organization_id FK
        text   name
        text   slug UK "namespace prefix; immutable"
        text   created_at
        text   archived_at "null while active"
    }
    REPOSITORY {
        text   id PK
        text   project_id FK
        text   owner
        text   name
        text   default_branch
        int    installation_id "GitHub App installation"
        text   image_repository
        int    service_port
        text   health_path
        int    enabled "0|1"
        text   connected_at
    }
    POLICY {
        text   id PK
        text   project_id FK UK
        int    ttl_days
        int    max_environments "global cap is platform-wide; this is the project share"
        text   cpu_limit
        text   memory_limit
        text   visibility "public|private"
        int    database_enabled "0|1"
        text   fork_policy "deny|approve|allow"
        text   updated_at
        text   updated_by FK
    }
    PREVIEW {
        text   id PK
        text   repository_id FK
        int    pr_number
        text   pr_title
        text   pr_author
        text   status "QUEUED|BUILDING|PROVISIONING|READY|UPDATING|FAILED|EXPIRING|DESTROYING|DESTROYED|REJECTED"
        text   status_reason "why, in product language"
        text   status_observed_at
        text   url
        text   namespace "orchestrator detail, recorded for support"
        text   lifecycle "ephemeral|pinned"
        text   created_at
        text   ready_at
        text   expires_at
        text   destroyed_at
    }
    DEPLOYMENT {
        text   id PK
        text   preview_id FK
        text   commit_sha
        text   image_tag
        text   trigger "open|synchronize|redeploy|rollback"
        text   status "pending|building|deploying|succeeded|failed"
        text   failure_kind "build|image|health|policy|capacity|unknown"
        text   failure_detail
        int    provisioning_seconds "null unless it reached READY"
        text   started_at
        text   finished_at
        int    is_last_known_good "0|1 — what rollback targets"
    }
    AUDIT_EVENT {
        text   id PK
        text   organization_id FK
        text   project_id FK "nullable"
        text   actor_user_id FK "nullable — null means the system"
        text   action "preview.created, policy.updated, repository.connected, ..."
        text   subject_type
        text   subject_id
        text   detail_json
        text   created_at
    }
    WEBHOOK_EVENT {
        text   id PK
        text   delivery_id UK "X-GitHub-Delivery — the idempotency key"
        text   event_type
        text   repository_id FK "nullable until resolved"
        text   received_at
        text   processed_at "null until handled"
        text   result "ok|ignored|failed"
        text   error
    }
```

---

## Tables, and the reasoning that is not obvious

**`PROJECT.slug` is immutable.** It prefixes every namespace and every
hostname. Renaming it would orphan running environments whose namespaces the
new slug no longer matches — the platform already learned this once, when a
second repository onboarded with no slug prefix took over the first one's
namespace for PR #1.

**`POLICY` is one row per project, not a key-value table.** Policies are a
fixed, small, reviewed set. A generic settings table would let anything become
a policy without a migration, and policy is exactly the place where "anything"
is dangerous.

**`POLICY.max_environments` is a project share, not the platform cap.** The
platform-wide cap is enforced by the lifecycle engine across all repositories
(P0-5) and lives with the platform, because a single node cannot honour the sum
of per-project promises.

**`PREVIEW` is keyed by `(repository_id, pr_number)`, not by PR number.** Pull
request #1 exists in every repository ever created.

**`PREVIEW.status_observed_at` exists so the UI can say "as of 40 seconds
ago".** A status with no observation time invites the reader to believe it is
current.

**`DEPLOYMENT` is one row per attempt.** A preview that failed twice and then
succeeded has three deployments; the preview has one row. This is what makes
"why did it fail" answerable after the fact, and what gives rollback a target:
`is_last_known_good` marks the most recent deployment that reached READY.

**`DEPLOYMENT.failure_kind` is a closed set.** The UI translates a kind into a
sentence a developer can act on; `failure_detail` carries the raw text
underneath. Without the enum, the product ends up printing Kubernetes errors as
its primary message, which §35 exists to prevent.

**`WEBHOOK_EVENT.delivery_id` is unique, and that uniqueness is the retry
protection.** GitHub redelivers. A second insert conflicts, the handler returns
200, and no second preview is created.

**`AUDIT_EVENT.actor_user_id` is nullable and null means the system.** TTL
expiry has no human actor, and recording one would be a lie in the record that
exists to be trusted.

---

## Indexes

| Index | Why |
|---|---|
| `previews (repository_id, pr_number)` UNIQUE | one preview per PR; the natural key |
| `previews (status)` | dashboard counts by state on every page load |
| `previews (expires_at)` WHERE `destroyed_at IS NULL` | the TTL sweep's only scan |
| `previews (created_at DESC)` | recent activity lists |
| `deployments (preview_id, started_at DESC)` | the history panel |
| `deployments (preview_id, is_last_known_good)` | rollback target lookup |
| `repositories (project_id)` | project page |
| `repositories (owner, name)` UNIQUE | a repository belongs to one project |
| `audit_events (organization_id, created_at DESC)` | audit view |
| `audit_events (project_id, created_at DESC)` | project activity |
| `webhook_events (delivery_id)` UNIQUE | idempotency |
| `webhook_events (processed_at)` WHERE NULL | the retry queue |
| `memberships (user_id)`, `memberships (organization_id, user_id)` UNIQUE | authorization on every request |

Partial indexes matter more than usual here: the sweep and the retry queue both
scan for a small live subset of tables that only grow, and SQLite will happily
do a full scan for years before anybody notices.

## Migrations and retention

Migrations are forward-only numbered SQL files applied at startup, in a
transaction, recorded in a `schema_migrations` table — the same shape
`node-pg-migrate` already gives the preview database, so there is one mental
model rather than two.

`DESTROYED` previews and their deployments are kept: they are the provisioning
metric history and the answer to "what happened last Tuesday". `WEBHOOK_EVENT`
rows are pruned after 30 days, since their only purpose is idempotency and
GitHub does not retry for anything like that long.
