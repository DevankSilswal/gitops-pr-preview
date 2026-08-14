# StackPreview — architecture

The product is a layer above an execution engine that already works. The
engine — ArgoCD, an ApplicationSet PR generator, a Helm chart, namespaces with
quotas and NetworkPolicies — is not rebuilt. The control plane orchestrates it.

The one rule that keeps this honest: **the control plane must not become a
kubectl wrapper.** It speaks in previews, deployments, policies and projects.
The fact that a preview is a namespace and a deployment is an ArgoCD Application
is an implementation detail that stops at the orchestrator boundary.

---

## 1. System architecture

```mermaid
flowchart TB
    subgraph users[People]
        DEV[Developer]
        REV[Reviewer]
        PE[Platform engineer]
    end

    subgraph product[StackPreview product layer — NOT IMPLEMENTED]
        GHA[GitHub App<br/>webhooks, checks, PR comments]
        API[Control Plane API<br/>modular monolith]
        DB[(SQLite<br/>projects, previews, audit)]
        UI[Dashboard]
    end

    subgraph control[Preview control plane]
        LIFE[Lifecycle engine<br/>TTL · capacity · cleanup]
        POL[Policy engine<br/>TTL · resources · visibility · forks]
        ORCH[Preview orchestrator<br/>create · update · destroy · status]
    end

    subgraph engine[Execution engine — LIVE today]
        ARGO[ArgoCD + ApplicationSet]
        K8S[Kubernetes k3s]
        NS[Preview namespaces<br/>quota · NetworkPolicy · PSA]
        ING[ingress-nginx + cert-manager]
    end

    DEV --> GHA
    REV --> UI
    PE --> UI
    GHA --> API
    UI --> API
    API --- DB
    API --> LIFE & POL & ORCH
    LIFE --> ORCH
    POL --> ORCH
    ORCH --> ARGO
    ARGO --> K8S --> NS --> ING
    ING -->|HTTPS| REV
```

Everything inside `engine` runs in production today. Everything inside
`product` does not exist yet. `control` exists in pieces: the lifecycle engine
is `scripts/lifecycle.js` running in GitHub Actions, and the policy engine is a
handful of values in `deploy/platform/onboarded/*.yaml`.

## 2. Pull request lifecycle

```mermaid
stateDiagram-v2
    [*] --> QUEUED: PR opened / reopened
    QUEUED --> REJECTED: policy or capacity refuses
    QUEUED --> BUILDING: admitted
    BUILDING --> FAILED: image build fails
    BUILDING --> PROVISIONING: image pushed
    PROVISIONING --> FAILED: sync or health fails
    PROVISIONING --> READY: HTTPS answers 200
    READY --> UPDATING: new commit pushed
    UPDATING --> READY: new commit serving
    UPDATING --> FAILED: build or sync fails
    READY --> EXPIRING: idle past TTL
    FAILED --> BUILDING: retry / redeploy
    EXPIRING --> DESTROYING: label removed
    READY --> DESTROYING: PR closed or merged
    FAILED --> DESTROYING: PR closed
    DESTROYING --> DESTROYED: namespace pruned
    DESTROYED --> [*]
```

`REJECTED` is a first-class state, not an error. A refused preview has a reason
— capacity full, repository not onboarded, fork without approval — and the
reason belongs in the pull request.

## 3. Provisioning sequence

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub
    participant APP as GitHub App
    participant API as Control Plane
    participant POL as Policy engine
    participant CI as Build (Actions)
    participant AS as ApplicationSet
    participant AR as ArgoCD
    participant K8 as Kubernetes

    GH->>APP: pull_request.opened (signed)
    APP->>API: verified webhook event
    API->>API: record WebhookEvent (idempotency key)
    API->>POL: may this PR have a preview?
    POL-->>API: admit / reject + reason
    alt rejected
        API->>GH: comment with the reason
    else admitted
        API->>GH: add `preview` label
        API->>API: Preview → QUEUED
        CI->>CI: build image tagged with head SHA
        CI->>GH: push image to registry
        API->>API: Preview → BUILDING → PROVISIONING
        AS->>GH: poll labelled PRs
        AS->>AR: template one Application per PR
        AR->>K8: namespace, Deployment, Service, Ingress, Certificate
        K8-->>AR: healthy
        API->>API: first HTTP 200 → Preview → READY
        API->>GH: comment the preview URL
    end
```

The image tag is the pull request's **head** SHA, never the merge commit.
GitHub checks out a synthetic merge commit for `pull_request` builds; ArgoCD
deploys the head. Tagging the wrong one produces an environment stuck pulling an
image that was never published, which is the single most common failure this
platform has had.

## 4. Cleanup sequence

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub
    participant LIFE as Lifecycle engine
    participant API as Control Plane
    participant AS as ApplicationSet
    participant AR as ArgoCD
    participant K8 as Kubernetes

    alt PR closed or merged
        GH->>API: pull_request.closed
    else idle past TTL
        LIFE->>GH: list PRs for every onboarded repository
        Note over LIFE: an API failure is UNKNOWN,<br/>never "no pull requests"
        LIFE->>LIFE: idle > TTL and not pinned?
    end
    API->>GH: remove the `preview` label
    AS->>AS: PR no longer matches the generator
    AS->>AR: delete the Application
    AR->>K8: prune namespace and every resource in it
    API->>API: Preview → DESTROYING → DESTROYED
    API->>API: AuditEvent recorded
```

Removing a label is the entire deletion API. Nothing in the product deletes a
namespace directly — desired state changes and ArgoCD prunes, so the reaper and
the controller cannot take turns undoing each other (ADR 0002).

## 5. Webhook flow

```mermaid
flowchart LR
    GH[GitHub] -->|POST /api/webhooks/github<br/>X-Hub-Signature-256| V{HMAC valid?}
    V -->|no| R401[401 · logged · no state change]
    V -->|yes| D{delivery id seen?}
    D -->|yes| OK200[200 · no-op, idempotent]
    D -->|no| STORE[(store WebhookEvent)]
    STORE --> Q[enqueue for processing]
    Q --> H[handler by event type]
    H --> S[state transition + AuditEvent]
```

Signature verification is not optional and the endpoint has no other
authentication. Deliveries are idempotent by `X-GitHub-Delivery`: GitHub retries,
and a retried delivery must not create a second preview.

## 6. Authentication flow

```mermaid
sequenceDiagram
    participant U as User
    participant UI as Dashboard
    participant API as Control Plane
    participant GH as GitHub OAuth

    U->>UI: Sign in with GitHub
    UI->>GH: OAuth authorize
    GH-->>API: callback with code
    API->>GH: exchange for access token
    API->>GH: read identity + org membership
    API->>API: upsert User, resolve Memberships
    API-->>UI: httpOnly session cookie
    UI->>API: subsequent calls carry the cookie
    API->>API: authorize per resource, server-side, every time
```

GitHub is the identity provider because every user of this product already has
a GitHub account and the product already needs GitHub permissions. No password
is ever stored. Frontend permission checks are for hiding buttons; the backend
authorizes every request regardless.

## 7. Failure and recovery

```mermaid
flowchart TB
    F{failure} --> B[Build failed]
    F --> D[Deploy failed]
    F --> C[Capacity full]
    F --> G[GitHub API unavailable]
    F --> N[Node lost]

    B --> BM["'The image for commit abc1234 did not build.'<br/>build log link · Retry"]
    D --> DM["'The environment started but never became healthy.'<br/>pod events in product language · Redeploy · Rollback"]
    C --> CM["'8 of 8 environments are in use.'<br/>what is holding them · when one frees"]
    G --> GM["state UNKNOWN · retry · no destructive cleanup"]
    N --> NM["every preview is down · production is down<br/>human runs az vm start · ArgoCD rebuilds from git"]
```

The rule for failure UX: the primary message is about the developer's change.
`ImagePullBackOff` is a detail shown lower down, not the headline.

## 8. Infrastructure topology

```mermaid
flowchart TB
    TF[Terraform<br/>infra/azure] --> AZ
    subgraph AZ[Azure · resource group gitops-k3s-rg]
        IP[Public IP<br/>Static · Standard<br/>separate resource from the VM]
        NIC[NIC]
        VM[VM Standard_B2als_v2<br/>2 vCPU · 4 GB · Regular priority]
        DISK[(OS disk 32 GB<br/>inline in the VM resource)]
    end
    IP --- NIC --- VM --- DISK
    VM --> K3S[k3s]
    K3S --> ARGO[ArgoCD] & ING[ingress-nginx] & CM[cert-manager] & MON[Prometheus]
    K3S --> PROD[production] & DEMO[demo · pinned] & PREV[preview namespaces]
    IP -.->|nip.io hostnames derive from this address| ING
```

The public IP and the NIC are separate resources from the VM, so replacing the
VM keeps every URL. The OS disk is inline in the VM resource, so replacing the
VM destroys k3s, ArgoCD and every environment — all of which are rebuilt from
git by the bootstrap. This is documented in `docs/runbook.md` and was verified
against Azure rather than assumed.

## 9. Data flow

```mermaid
flowchart LR
    subgraph src[Sources of truth]
        TFO[Terraform · public IP]
        GIT[Git · charts, policies, onboarded repos]
        GHS[GitHub · PR state, labels]
    end
    TFO -->|base-host.js| HOST[base hostname]
    HOST --> CHART[platform chart values]
    GIT --> ARGO[ArgoCD]
    CHART --> ARGO
    GHS --> AS[ApplicationSet generator]
    AS --> ARGO
    ARGO --> LIVE[live cluster state]
    LIVE --> DRIFT[drift checker every 20 min]
    GIT --> DRIFT
    DRIFT --> REPORT[(drift report)]
    LIVE --> API[Control Plane<br/>reads status, never invents it]
    API --> DBS[(SQLite)]
```

There is exactly one source of truth per fact. The node address belongs to
Terraform. Chart and policy belong to git. Pull request state belongs to
GitHub. The control-plane database holds product state — projects, users,
previews, audit — and **never becomes a second opinion about the cluster**: it
records what it observed and when, and reads live status from the orchestrator.

## 10. Control-plane architecture

```mermaid
flowchart TB
    subgraph api[Control Plane · modular monolith]
        HTTP[HTTP layer<br/>routing · validation · session]
        subgraph mods[Modules]
            AUTH[auth]
            PROJ[projects]
            REPO[repositories]
            PREV[previews]
            DEP[deployments]
            LIFEM[lifecycle]
            POLM[policies]
            GHM[github]
            AUD[audit]
            OBS[observability]
        end
        ORCH[PreviewOrchestrator interface]
        PERS[(persistence · SQLite)]
    end
    HTTP --> mods --> PERS
    PREV --> ORCH
    LIFEM --> ORCH
    ORCH --> IMPL[ArgoCDOrchestrator<br/>the only module that knows Kubernetes exists]
    IMPL --> K8S[ArgoCD / Kubernetes API]
```

A modular monolith, not microservices. One process, one database file, module
boundaries enforced by imports rather than by network calls. Splitting this into
services would multiply the operational surface on a node that already runs at
74% memory, and would buy nothing at the scale this targets.

`PreviewOrchestrator` is the seam:

```
create(preview)    →  label the PR; the ApplicationSet does the rest
update(preview)    →  nothing; a new commit is a new image tag
destroy(preview)   →  remove the label; ArgoCD prunes
rollback(preview)  →  point the Application at the previous known-good tag
status(preview)    →  read the Application and its workloads
logs(preview)      →  stream from the workload
```

Only `ArgoCDOrchestrator` imports a Kubernetes client. If a second
implementation is ever needed, nothing above this line changes — and more
importantly, the product cannot accidentally grow a `kubectl apply` endpoint.
