# StackPreview

> Self-hosted GitOps preview environments for engineering teams.

Turn every pull request into an isolated, shareable, production-like environment
— on infrastructure you own, with the runtime never leaving your cluster.

---

## What this document is, and what it is not

This is the product specification. It describes what StackPreview is meant to
be, and it is deliberately explicit about the gap between that and what runs
today, because the platform underneath it is real and already serving traffic.

Every capability below carries an evidence class:

| Class | Meaning |
|---|---|
| **LIVE** | running in production now, verified against the real cluster |
| **KIND** | verified in the CI kind cluster only |
| **CODE ONLY** | implemented, never executed against anything real |
| **NOT IMPLEMENTED** | specified here, not built |
| **BLOCKED** | cannot be built until a named external dependency is resolved |

Nothing in this file may be promoted to LIVE without evidence recorded against
the production cluster. That rule exists because this repository has already
shipped three things that looked green and did nothing: a spot watchdog gated on
a variable that was never set, an alert pipeline pointed at a Prometheus URL
that was never configured, and a TTL sweep that could only see one of the two
repositories it governed.

---

## What are we building?

A self-hosted platform that turns a pull request into a running application.

```
GitHub PR opened
      ↓
StackPreview validates policy and admits the preview
      ↓
image is built for that exact commit
      ↓
an isolated Kubernetes environment is provisioned
      ↓
a unique HTTPS URL is posted back to the pull request
      ↓
reviewer clicks it and uses the actual application
      ↓
PR updated  → the same preview updates
PR closed   → the preview is destroyed and its resources released
```

The engine that performs this exists and works. What does not exist is the
product around it: there is no API, no database, no dashboard, no user, and no
concept of a project. Today a repository is onboarded by committing a YAML file
and running a bootstrap script, which is a platform, not a product.

## Why are we building it?

Reviewing a pull request by reading a diff is guesswork. The alternatives teams
actually use are worse than they look:

| Current practice | What it costs |
|---|---|
| Run the branch locally | every reviewer needs the whole stack running |
| Share a staging environment | one environment, many branches, contention and cross-contamination |
| Deploy to staging to review | the queue becomes the bottleneck; staging holds unrelated changes |
| Screenshot in the PR | the reviewer never touches the thing being changed |
| Spin up an environment by hand | it is forgotten, and it bills until somebody notices |

Commercial platforms solve this by running your application on their runtime.
That is the trade StackPreview refuses: the differentiator is **not** "PR → URL",
which several products already do well. It is that the runtime stays on
infrastructure the team controls, with Kubernetes-native isolation, GitOps
reconciliation, explicit resource governance and a lifecycle that cleans up
after itself.

## Who will use it?

| Persona | Wants | Judges the product by |
|---|---|---|
| **Developer** | PR → preview, fast, and an understandable failure when it is not | time from push to usable URL |
| **Reviewer** | one click to a working application, no local setup | whether the link works when clicked |
| **QA engineer** | an environment pinned to a specific commit, isolated, with logs | reproducibility |
| **Platform engineer** | policy, isolation, resource limits, lifecycle, recovery | whether it can be operated without heroics |
| **Engineering manager** | staging contention gone, visibility across the team | fewer blocked reviews |

The organizational customer is a team that wants preview environments without
handing its application runtime to a third party.

## What does success look like?

A developer connects a repository. They open PR #24. StackPreview creates
`https://pr-24.<preview-domain>`. The reviewer opens it and the real
application is running at that exact commit. The developer pushes again and the
same preview updates. When the preview fails, the product says why in language
about builds and commits rather than about `ImagePullBackOff`. When the PR
closes, the environment is destroyed.

Nobody runs `kubectl`, `helm` or `argocd` for any of that.

---

## Goals

1. Automatic PR previews
2. Isolated Kubernetes environments per preview
3. HTTPS on every preview URL
4. A GitHub-native developer experience
5. Automatic lifecycle management — TTL, cleanup, capacity
6. Resource governance that a single node can actually enforce
7. Security isolation between previews, and a stricter model for forks
8. Self-hosted operation with no mandatory vendor runtime
9. Failure diagnosis in product language
10. GitOps-managed infrastructure
11. An observable platform
12. A product UX a developer understands in five minutes

## Non-goals for V1

Not a general-purpose Kubernetes dashboard. Not a CI/CD replacement. Not an
observability platform, a service mesh, a cloud provider, a billing system, or a
multi-cloud control plane. Features outside the preview lifecycle do not belong
in V1 however easy they would be to add.

**There is no billing system, and none is planned for the MVP.** The product
reports estimated infrastructure usage and capacity; it never presents that as
an invoice. See [`cost.md`](../cost.md).

---

## User stories

**Developer**
- I connect my GitHub repository so previews are created without me asking.
- I push a commit and the existing preview updates, rather than a second one appearing.
- I see why a preview failed, in terms of my build and my commit.
- I redeploy a preview without touching the cluster.

**Reviewer**
- I open a link from the pull request and use the change, with no local setup.
- I trust that the environment is the commit under review and nothing else.

**QA engineer**
- I test against an environment pinned to one commit, isolated from every other preview.
- I read logs and events for that environment without cluster access.

**Platform engineer**
- I set a global cap so one repository cannot consume the whole node.
- I know each preview is isolated by namespace, NetworkPolicy, quota and Pod Security Admission.
- I see drift between what git says and what the cluster is doing.
- I can rebuild the cluster from git after losing the node.

**Engineering manager**
- I see how many previews are active, how long provisioning takes, and what fails.

---

## Features, and what is actually true today

### Core MVP

| Feature | State | Note |
|---|---|---|
| PR detection (opened/reopened/synchronize/closed) | **LIVE** | GitHub Actions + ArgoCD ApplicationSet PR generator |
| Preview creation, one per qualifying PR | **LIVE** | isolated namespace per PR |
| Unique HTTPS preview URL | **LIVE** | per-host Let's Encrypt certificate |
| Preview updates on new commit | **LIVE** | image tagged with head SHA |
| Automatic cleanup on PR close | **LIVE** | ApplicationSet prunes the Application |
| TTL expiry | **LIVE** | 3 days idle, `scripts/lifecycle.js` |
| Global capacity across all repositories | **LIVE** | P0-5; 8 environments, counted once |
| Pinned environment that never expires | **LIVE** | the permanent demo, structurally outside the sweep |
| Multi-repository support | **LIVE** | two repositories onboarded and served |
| Preview URL posted to the PR | **LIVE** | bot comment, checked before posting |
| **Preview status as a product state machine** | **NOT IMPLEMENTED** | today status is "whatever ArgoCD says" |
| **Dashboard** | **NOT IMPLEMENTED** | — |
| **Logs and events in the product** | **NOT IMPLEMENTED** | `kubectl` only |
| **Repository connection through a UI** | **NOT IMPLEMENTED** | today it is a commit plus a bootstrap run |

### Security

| Feature | State | Note |
|---|---|---|
| Namespace isolation, NetworkPolicy, ResourceQuota, Pod Security Admission | **LIVE** | rendered by the preview chart for every environment |
| Onboarding allowlist — who may run code here | **LIVE** | ADR 0011 |
| Fork previews get a read-only token and no registry write | **LIVE** | two-stage workflow |
| Private previews with a derived password | **CODE ONLY** | no `secretSalt` on the cluster, so authentication is off |
| Webhook signature verification | **NOT IMPLEMENTED** | no GitHub App yet |
| Product RBAC (Owner/Admin/Developer/Viewer) | **NOT IMPLEMENTED** | there are no users |

### Platform

| Feature | State |
|---|---|
| ArgoCD, Kubernetes, Helm, Terraform, ingress-nginx, cert-manager | **LIVE** |
| GitOps-managed control plane (app-of-apps) | **LIVE** (P0-3) |
| Automated drift detection | **LIVE** (P0-4) |
| Wildcard TLS | **CODE ONLY** — never issued (P0-7) |
| Real alerting | **BLOCKED** — no Actions secrets exist (P0-10) |
| Spot failure detection and recovery | **BLOCKED** — watchdog inert, and the VM is not Spot (P0-11) |

### Advanced

Multi-service, worker, ephemeral Postgres, custom domains, environment
variables, rollback, audit log, team policies — **NOT IMPLEMENTED** as product
features. The chart can render a worker and an ephemeral database; neither has
run in a real preview.

---

## MVP scope

```
GitHub App  +  Control Plane API  +  Database  +  Preview Orchestrator
            +  Dashboard          +  GitHub PR integration
```

on top of the existing execution engine, which is not rebuilt.

**Explicitly excluded from MVP:** billing, enterprise SSO, multi-region,
multi-cloud, analytics, a Kubernetes UI, organizations with nested teams.

**MVP is complete when** the flow in [`acceptance.md`](./acceptance.md) runs
end to end against the real cluster: sign in, create a project, connect a
repository, open a PR, receive a preview URL, push again and watch the same
preview update, close the PR and watch it be destroyed — with the permanent demo
still up afterwards.

---

## Non-functional requirements

**Availability.** Single node, single VM. There is no HA and the product must
not imply otherwise. `docs/runbook.md` records exactly what recovers on its own
and what needs a human.

**Performance.** Provisioning time is measured, not promised. p50 and p95 are
reported from real samples; no SLO is stated until there are at least 20 samples
of the same kind, and today's samples are redeployments rather than first
provisions (P0-9).

**Security.** Least privilege, no secrets in git, isolation between previews,
authenticated webhooks, and a stricter trust model for forks.

**Reliability.** Every lifecycle operation is idempotent and retry-safe.
"Already gone" is never an error. An unknown state is never treated as an empty
one.

**Resource budget.** 2 vCPU / 4 GB. Sustained memory is already at 74%, which
is why the control plane uses SQLite rather than a database server — see
[ADR 0014](../decisions/0014-control-plane-datastore.md).
