# StackPreview — API

REST over JSON. Session cookie for humans, HMAC signature for GitHub, nothing
else. The API never proxies the Kubernetes API and never accepts a manifest:
everything it exposes is a product noun.

Status: **NOT IMPLEMENTED.** This is the contract Stage 4 builds against.

---

## Conventions

- IDs are opaque strings. Clients never construct one.
- Times are RFC 3339 UTC.
- Errors are `{ "error": { "code": "...", "message": "...", "detail": {...} } }`
  where `message` is written for a developer to read, not for a machine to parse.
- Mutations that a human triggered are audited; reads are not.
- `409` means the request conflicted with current state, never "already done" —
  idempotent operations return `200`.

## Health

```http
GET /api/health        → 200 {"status":"ok","version":"...","checks":{...}}
```

Unauthenticated, and deliberately shallow: it reports whether the control plane
itself is serving. Cluster health is a separate concern and lives at
`/api/platform/health`, because a control plane that reports itself unhealthy
whenever the cluster is degraded cannot be used to diagnose the cluster.

## Projects

```http
GET    /api/projects                  → list projects the caller can see
POST   /api/projects                  {name}          → 201
GET    /api/projects/:id              → project + counts
PATCH  /api/projects/:id              {name}          → 200
DELETE /api/projects/:id              → 202  archives; destroys previews first
```

`DELETE` is asynchronous and returns `202` because it must destroy every
preview the project owns before the project can go. A synchronous delete would
either block for minutes or lie.

## Repositories

```http
GET    /api/projects/:id/repositories
POST   /api/projects/:id/repositories  {owner,name,installation_id,
                                        image_repository,service_port,health_path}
GET    /api/repositories/:id
PATCH  /api/repositories/:id           {enabled,service_port,health_path}
DELETE /api/repositories/:id           → 202  disconnects; destroys its previews
```

Connecting a repository requires the GitHub App to be installed on it. The API
verifies the installation rather than trusting the request: a caller who could
name any repository could otherwise have this platform run code from a
repository they do not control — which is the onboarding allowlist's whole
purpose (ADR 0011).

## Previews

```http
GET    /api/previews                  ?project=&repository=&status=&limit=&cursor=
GET    /api/previews/:id              → preview + current deployment + policy applied
POST   /api/previews/:id/redeploy     → 202  new Deployment, same preview
POST   /api/previews/:id/rollback     {deployment_id?}  → 202  defaults to last known good
DELETE /api/previews/:id              → 202  destroy now, ahead of TTL
GET    /api/previews/:id/logs         ?container=&since=&follow=  → text/event-stream
GET    /api/previews/:id/events       → product events, not raw Kubernetes events
```

There is no `POST /api/previews`. A preview exists because a pull request
exists; creating one by hand would produce an environment with no lifecycle and
nothing to clean it up. The nearest legitimate operation is pinning, which is a
policy change on an existing preview:

```http
POST   /api/previews/:id/pin          → 200  lifecycle: ephemeral → pinned
DELETE /api/previews/:id/pin          → 200
```

Pinned previews are exempt from TTL and never counted as reclaimable capacity.
The permanent demo is pinned and additionally lives outside the pull-request
lifecycle entirely.

`GET /api/previews/:id/events` returns product events — *"image for `abc1234`
failed to build"*, *"environment became healthy after 84s"* — assembled from
deployments and orchestrator observations. Raw Kubernetes events appear only in
a `detail` field, never as the headline (§35).

## Policies

```http
GET    /api/projects/:id/policies     → effective policy + which values are platform-capped
PUT    /api/projects/:id/policies     {ttl_days,max_environments,cpu_limit,
                                       memory_limit,visibility,database_enabled,fork_policy}
```

The response marks values the platform overrides. A project may ask for 20
environments on a node that permits 8 in total; the API stores the request and
reports the effective value, rather than silently accepting a number that can
never be honoured.

## Platform

```http
GET    /api/platform/health           → node, ArgoCD, ingress, certificates, drift
GET    /api/platform/capacity         → used / max / pinned / unknown repositories
GET    /api/platform/metrics          → provisioning p50/p95 by kind, success rate
```

`capacity` reports `unknown_repositories` explicitly. A repository whose pull
requests could not be listed is not zero previews, and the number the dashboard
shows must be able to say so (P0-5).

## Audit

```http
GET /api/audit                        ?project=&actor=&action=&from=&to=&cursor=
```

Append-only. There is no endpoint that edits or deletes an audit event.

## Webhooks

```http
POST /api/webhooks/github
     X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery
```

1. Verify HMAC over the raw body with a timing-safe comparison. Invalid → `401`,
   logged, no state change.
2. Insert the delivery id. Conflict → `200` immediately; the event was already
   handled.
3. Enqueue and return `200` fast. GitHub times out at 10 seconds, and handling a
   `pull_request.opened` involves policy evaluation and a GitHub write.

Handled: `pull_request` (opened, reopened, synchronize, closed),
`installation` / `installation_repositories`, `ping`. Everything else is stored
and ignored, so an unexpected event type is visible rather than silently
dropped.

---

## Authentication

| Caller | Mechanism |
|---|---|
| Human | GitHub OAuth → `httpOnly`, `Secure`, `SameSite=Lax` session cookie |
| GitHub | HMAC-SHA256 signature over the raw request body |
| Control plane → GitHub | GitHub App installation token, minted per request, short-lived |
| Control plane → cluster | in-cluster ServiceAccount; no kubeconfig is ever stored |

No API keys in V1. Adding a second credential type before anyone has asked for
one is how a product acquires a credential nobody rotates.

## Authorization

Roles are per organization; permission is resolved per resource, on the server,
on every request.

| Action | Owner | Admin | Developer | Viewer |
|---|---|---|---|---|
| View project, previews, status | ✓ | ✓ | ✓ | ✓ |
| Open a preview URL | ✓ | ✓ | ✓ | ✓ |
| View logs and events | ✓ | ✓ | ✓ | — |
| Redeploy, rollback | ✓ | ✓ | ✓ | — |
| Destroy a preview | ✓ | ✓ | ✓ | — |
| Pin / unpin | ✓ | ✓ | — | — |
| Connect or disconnect a repository | ✓ | ✓ | — | — |
| Edit policies | ✓ | ✓ | — | — |
| Manage members | ✓ | — | — | — |
| Delete project | ✓ | — | — | — |
| View audit | ✓ | ✓ | — | — |

Two rules that are easy to get wrong:

**Logs are not viewer-visible.** A preview's logs can contain anything the
application logs, including data a reviewer has no business seeing. Viewing the
running application is a weaker permission than reading its logs.

**A private preview's URL is not an authorization boundary.** Access to the
running application is enforced at the ingress, not by knowing the link. Until
that is live (P0-8), every preview is reachable by anyone with the URL and the
product must say so rather than implying otherwise.
