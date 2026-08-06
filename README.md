# GitOps Platform with PR Preview Environments

**Live:** https://app.20-24-211-179.nip.io — the `main` branch, deployed by ArgoCD from a commit CI made to this repository.

Open a pull request here and a second environment appears at `https://devanksilswal-gitops-pr-preview-pr-<number>.20-24-211-179.nip.io` within about a minute, then disappears when the pull request closes.

It is not tied to this repository, or to this cluster. A second one, [notes-board](https://github.com/DevankSilswal/notes-board) — Python, a different port, a different health path — is served by the same cluster with no platform code of its own.

**To use it on your own repository:** add a workflow call, `.github/preview.yml`, and the `pr-preview` topic. An hourly job finds you and onboards you — nobody approves it. [Full instructions](docs/onboarding.md). Or fork this and run your own cluster:

```bash
make init          # points the fork at itself
make dev-cluster   # locally, or infra/azure for a cloud VM
make dev-bootstrap
```


Every pull request automatically gets its own isolated, publicly reachable Kubernetes environment — created when the PR opens, updated on every push, and destroyed when the PR closes. Think Vercel/Netlify preview deploys, built from scratch on Kubernetes with ArgoCD.

## Why

Reviewing a pull request by reading a diff is guesswork. Preview environments let a reviewer click a link and use the actual change. Commercial platforms give this away for free on their own runtime; this project builds the same capability on a self-managed Kubernetes cluster, which is what the underlying GitOps machinery looks like in a real infrastructure team.

## Architecture

```
GitHub PR opened
      |
      v
GitHub Actions ---- build image, tag with PR SHA ----> GHCR
      |
      v
ArgoCD ApplicationSet (PR generator)
      |
      +-- detects open PRs, creates one Application per PR
      |
      v
Kubernetes cluster
      |
      +-- namespace: <slug>-pr-<number>
      +-- ingress:   <slug>-pr-<number>.<node-ip-in-dashes>.nip.io
      |
      v
Reviewer opens the URL, posted back as a PR comment
```

When the PR closes, the ApplicationSet stops generating that Application and ArgoCD prunes the namespace automatically.

### Lifecycle is a label

An environment exists exactly while its pull request carries the `preview` label. CI adds the label when a PR opens; an hourly job removes it once the PR has been idle past its TTL. Nothing ever deletes a namespace directly — the label *is* the desired state, and ArgoCD reconciles to it.

That matters because the obvious alternative, a cron job that deletes stale namespaces, fights the controller: the ApplicationSet would notice the Application missing and immediately recreate it. Expressing expiry as a change in desired state means the two cooperate instead. Re-adding the label brings the environment back.

### Preview environments are hostile by default

A preview environment runs unreviewed code, in many cases from a repository this platform's operator does not control. Treating that as trusted is the mistake this design is built around avoiding.

- **The chart comes from the platform, not the pull request.** It used to be read from the branch under review, which meant anyone able to open a pull request could add a ClusterRoleBinding to it and have ArgoCD apply it with ArgoCD's privileges. A pull request can now change what is deployed, never how.
- **ArgoCD's `default` project is not used.** It permits every repository, namespace and resource kind. Previews run under a project scoped to the chart repository, `*-pr-*` namespaces, and a resource list containing nothing that grants permissions.
- **Environments cannot reach each other.** A NetworkPolicy admits only the ingress controller and permits egress to DNS and the public internet with the private ranges carved out, including the link-local metadata service that hands instance credentials to anything that asks.
- **One environment cannot starve the rest.** A ResourceQuota caps each namespace and a LimitRange supplies defaults, so a pull request that leaks memory or asks for ten replicas is refused rather than allowed to take the node down.
- **The container holds nothing it does not need.** It runs as a fixed non-root UID on a read-only root filesystem with all capabilities dropped, and npm is deleted from the runtime image — nothing there invokes it, and its bundled dependencies were the source of every CRITICAL the image scan reported.

## Components

| Piece | Choice | Reason |
|---|---|---|
| Cluster | k3s on a single Azure VM | Nothing here needs managed Kubernetes, and one node keeps a student budget alive. The bootstrap script takes only a node address, so nothing above it knows which cloud it is on |
| GitOps | ArgoCD + ApplicationSet PR generator | The PR generator is what makes per-PR environments declarative rather than scripted |
| CI | GitHub Actions | Builds and pushes images; never talks to the cluster directly |
| Registry | GHCR | Free for public images, native GitHub auth |
| Ingress | ingress-nginx | Routes every `<slug>-pr-<n>` hostname to the right namespace by Host header |
| DNS | nip.io | Wildcard hostnames with no domain to buy or configure |
| TLS | cert-manager + Let's Encrypt | Optional, staging issuer by default — preview hostnames churn past the production rate limit |
| Observability | Prometheus, no operator | Alerts on environments that never become healthy. Grafana and the operator are opt-in — they need four vCPU, which this node does not have |

CI builds artifacts; ArgoCD deploys them. The pipeline holds no cluster credentials — the cluster pulls its own desired state from git. That separation is the point of GitOps.

## Repository layout

```
app/                                    Sample service deployed into each environment
charts/preview-app/                     Helm chart, one release per environment
deploy/platform/onboarded/                     One file per repository — ArgoCD reads this directly from git
deploy/platform/platform.yaml                  Where the chart comes from
deploy/argocd/applicationset-preview.yaml      Pull request generator — the core mechanism
.github/workflows/preview-build.yml            Reusable workflow other repositories call
deploy/argocd/application-prod.yaml            main branch, same chart
.github/workflows/build.yml             Test, multi-arch build, GHCR push, PR comment, release
.github/workflows/preview-lifecycle.yml Grants the preview label, expires it on TTL
deploy/platform/cluster-issuers.yaml           Let's Encrypt issuers for preview TLS
deploy/platform/observability/                 Prometheus values and Grafana dashboard
infra/azure/                            Terraform for the Azure VM running k3s
scripts/bootstrap-cluster.sh            One-shot cluster setup
scripts/e2e-test.sh                     Preview environment tested on a real cluster
docs/onboarding.md                      How another repository adopts this
docs/runbook.md                         Every failure this platform has actually produced
```

The application in `app/` is deliberately trivial. It reports its own environment name, PR number, git SHA, and build time, so that opening a preview URL immediately proves *which* commit is running there. All of it arrives through environment variables set by CI and Kubernetes.

## Build phases

- [x] **Phase 1 — Sample application.** Express app exposing `/`, `/api/health`, `/api/info`; env-var-driven build identity; multi-stage Docker build on a non-root user; graceful SIGTERM shutdown; unit tests.
- [x] **Phase 2 — Deployable unit.** Helm chart rendering a Deployment, Service and Ingress per environment, with probes on `/api/health`. Verified with `helm lint` / `helm template`.
- [x] **Phase 3 — CI.** GitHub Actions runs the tests, then builds and pushes an `amd64`/`arm64` image to GHCR tagged `pr-<number>-<head-sha>`. CI holds no cluster credentials; releasing to production is a commit to a values file that ArgoCD reads.
- [x] **Phase 4 — GitOps definitions.** ApplicationSet PR generator and the production Application, both written and YAML-validated.
- [x] **Phase 5 — Infrastructure as code.** Terraform provisioning one Azure VM running k3s via cloud-init, plus a bootstrap script that takes only a node address and so does not know which cloud it is on.
- [x] **Phase 6 — Lifecycle and operations.** Label-driven TTL expiry, preview URL posted as a pull request comment, optional Let's Encrypt TLS, a locked-down pod security context, and a Grafana dashboard covering the fleet.
- [x] **Phase 7 — Proven end to end** against a live cluster. See below.
- [x] **Phase 8 — A public cluster.** Running on Azure with browser-trusted TLS. The manifests did not change; only the address did.

## What has actually been verified

Run against a live Kubernetes cluster, driving a real GitHub pull request, pulling real images from GHCR:

| Behaviour | Result |
|---|---|
| ApplicationSet discovers a labelled PR | Application `preview-pr-1` generated within ~60s |
| ArgoCD syncs the chart | Namespace, Deployment, Service and Ingress created, `Synced/Healthy` |
| Preview serves the PR's own code | The page showed a heading added *by that PR*, absent from `main` |
| Build identity is correct | `/api/info` reported PR number 1 and that PR's head SHA |
| Pushing to the PR updates it | New commit, new image tag, environment reconciled with no manual step |
| Container runs unprivileged | `id` inside the pod: `uid=10001(appuser)`, read-only root filesystem |
| Removing the label tears it down | Application, namespace and URL all gone; the URL returns 404 |
| Nothing leaks | Zero `pr-*` namespaces remain afterwards |
| A second repository works with no platform changes | `notes-board` — Python, port 8080, `/healthz` — onboarded with one small file and a workflow call, and served from the same cluster |
| Onboarding and offboarding are commits | Deleting that file removed its environment and namespace; committing it back brought them back. Nothing was run against the cluster in either direction |
| Repositories onboard themselves | Discovery ran against real GitHub, found nine repositories carrying the topic, onboarded the two that had opted in properly and named a reason for each it skipped |
| CI comments the preview URL | Posted once, then edited in place on the next push rather than duplicated |
| TTL sweep expires an idle environment | Label removed, PR commented, environment gone without anything deleting it directly |
| TLS is issued per environment | `pr-1.…nip.io` served a certificate with a matching SAN; an unknown host still gets ingress-nginx's fallback |
| The Grafana dashboard is real | Loaded from its ConfigMap, and all six panel queries returned data from the live environment |
| Re-running the bootstrap is safe | A second, third and fourth run changed nothing and broke nothing |
| Environments are network-isolated | A pod in another namespace timed out reaching the preview's service, while the ingress path still returned 200 |
| Cloud metadata is unreachable | A request to `169.254.169.254` from inside a preview pod timed out |
| Quotas are enforced, not decorative | `ResourceQuota` reported live usage: `pods: 1/4`, `requests.cpu: 25m/500m` |
| Images carry no fixable HIGH/CRITICAL | Trivy gates the build; the CRITICAL it originally found is gone |
| Alerts fire on real failures | A deliberately broken environment was created on the live cluster; Prometheus saw it and `PreviewImagePullFailing` went pending, then firing |
| It runs on a public cloud, not just locally | Azure VM in `eastasia`; the bootstrap script was unchanged, taking only an owner and an address |
| Certificates are browser-trusted | Let's Encrypt production issued for both hostnames; `curl` without `-k` succeeds |
| Releases reach production unattended | A commit pushed to `main` appeared at the live production URL with no deploy step |
| The whole cluster rebuilds from code | The VM was destroyed and recreated by Terraform; the bootstrap script and ArgoCD restored production and every preview environment with no manual step, and the static IP kept every URL working |
| Infrastructure code matches reality | `terraform plan` reports no changes — earlier it wanted to replace the VM, because a fix had been applied by hand and only later written down |
| Production survives its own rollout | Two replicas, `maxUnavailable: 0`, and a disruption budget that renders only above one replica |

Four bugs were found only by running this, and are fixed:

1. The image tag could never match, because GitHub Actions builds the PR's *merge* commit while ArgoCD asks for its *head*.
2. `kubectl apply` fails on ArgoCD's CRDs — they exceed the annotation size limit that client-side apply relies on.
3. nip.io reads `pr-1.127.0.0.1` as the address `1.127.0.0`, so every preview URL resolved somewhere else and timed out.
4. Namespaces survived pruning, because `CreateNamespace=true` creates them outside the set ArgoCD tracks.

Both of the gaps that needed a publicly reachable address are now closed. The platform runs on an Azure VM in `eastasia`, and both hostnames serve certificates issued by Let's Encrypt production — `curl` without `-k` succeeds, so a browser shows no warning.

## Try it locally

No cloud account needed — this is the same path the verification above took.

```bash
make dev-cluster                      # kind cluster with ports 80/443 mapped
make dev-bootstrap OWNER=<your-user>  # ingress-nginx, ArgoCD, the ApplicationSet
gh pr edit <n> --add-label preview    # environment appears within ~60s
curl http://pr-<n>.127-0-0-1.nip.io/api/info
make dev-down
```

## Deploying to a real cluster

Terraform provisions one VM running k3s; the bootstrap script does not know or
care which cloud it is on, taking only a GitHub owner and the node's address.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gitops -N ''

terraform -chdir=infra/azure init
terraform -chdir=infra/azure apply \
  -var subscription_id=$(az account show --query id -o tsv) \
  -var ssh_public_key="$(cat ~/.ssh/gitops.pub)"

# point kubectl at it, then
GITHUB_TOKEN=$(gh auth token) ./scripts/bootstrap-cluster.sh <owner> <public-ip>
```

On a student credit the VM, not the cluster, is what costs money. `make
azure-stop` deallocates it between demonstrations, which stops compute charges
while keeping the disk and the static IP — stopping the machine from inside the
guest does not, because Azure keeps billing a VM it still has reserved.

`make validate` runs everything checkable without a cluster: tests, chart lint in both TLS modes, and `terraform validate`.

## Running the sample app locally

```bash
cd app
npm install
npm test
npm start        # http://localhost:3000
```

Or as the container that actually gets deployed:

```bash
cd app
docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t preview-app .
docker run -p 3000:3000 -e ENVIRONMENT=pr-42 -e PR_NUMBER=42 preview-app
curl localhost:3000/api/info
```
