# GitOps Platform with PR Preview Environments

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
k3s cluster (Oracle Cloud free tier)
      |
      +-- namespace: pr-<number>
      +-- ingress: pr-<number>.preview.<domain>
      |
      v
Reviewer opens the URL, posted back as a PR comment
```

When the PR closes, the ApplicationSet stops generating that Application and ArgoCD prunes the namespace automatically. A TTL job also expires environments that outlive an open-but-stale PR.

## Components

| Piece | Choice | Reason |
|---|---|---|
| Cluster | k3s on Oracle Cloud Always Free | Real cluster, real public IPs, no time-limited trial credits |
| GitOps | ArgoCD + ApplicationSet PR generator | The PR generator is what makes per-PR environments declarative rather than scripted |
| CI | GitHub Actions | Builds and pushes images; never talks to the cluster directly |
| Registry | GHCR | Free for public images, native GitHub auth |
| Ingress | ingress-nginx + cert-manager | Wildcard DNS `*.preview.<domain>` with automatic TLS |
| Observability | Prometheus + Grafana + Loki | Tracks active environments and their resource cost |

CI builds artifacts; ArgoCD deploys them. The pipeline holds no cluster credentials — the cluster pulls its own desired state from git. That separation is the point of GitOps.

## Repository layout

```
app/       Sample application that gets deployed into each preview environment
gitops/    Kubernetes manifests / Helm chart and ArgoCD definitions  (Phase 3+)
infra/     Terraform for the Oracle Cloud VM and networking          (Phase 2)
```

The application in `app/` is deliberately trivial. It reports its own environment name, PR number, git SHA, and build time, so that opening a preview URL immediately proves *which* commit is running there. All of it arrives through environment variables set by CI and Kubernetes.

## Build phases

- [x] **Phase 1 — Sample application.** Express app exposing `/`, `/api/health`, `/api/info`; env-var-driven build identity; multi-stage Docker build on a non-root user; graceful SIGTERM shutdown; unit tests.
- [x] **Phase 2 — Deployable unit.** Helm chart rendering a Deployment, Service and Ingress per environment, with probes on `/api/health`. Verified with `helm lint` / `helm template`.
- [x] **Phase 3 — CI.** GitHub Actions runs the tests, then builds and pushes an `arm64` image to GHCR tagged `pr-<number>-<head-sha>`. CI holds no cluster credentials.
- [x] **Phase 4 — GitOps definitions.** ApplicationSet PR generator and the production Application, both written and YAML-validated.
- [x] **Phase 5 — Infrastructure as code.** Terraform for the Oracle Cloud VCN and Ampere A1 node, k3s via cloud-init, plus a one-shot cluster bootstrap script. `terraform validate` passes.
- [ ] **Phase 6 — First live environment.** Blocked only on the Oracle Cloud instance. Apply the Terraform, run the bootstrap script, open a PR.
- [ ] **Phase 7 — Polish.** TLS via cert-manager, preview URL posted as a PR comment, TTL expiry for stale environments, Grafana dashboard.

Phases 2–5 are written and validated offline but have not yet run against a real cluster; Phase 6 is what proves them.

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
