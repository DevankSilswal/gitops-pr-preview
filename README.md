# GitOps Platform with PR Preview Environments

Every pull request gets its own isolated Kubernetes environment and a public
URL — created when it opens, updated on every push, destroyed when it closes.
What Vercel does on its own runtime, done on a self-managed cluster, and open
for any repository to join.

**Live:** [app.20-24-211-179.nip.io](https://app.20-24-211-179.nip.io) — the
`main` branch, deployed by ArgoCD from a commit CI made to this repository.
Open a pull request and a second environment appears at
`https://devanksilswal-gitops-pr-preview-pr-<number>.20-24-211-179.nip.io`
within about a minute.

It is not tied to this repository. A second one,
[notes-board](https://github.com/DevankSilswal/notes-board) — Python, a
different port, a different health path — is served by the same cluster with no
platform code of its own.

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

### Previews are private, and prove they work

Two things separate a preview environment that is useful from one that is a
demo.

**It is not public.** Every environment sits behind a password, and every
response carries `X-Robots-Tag: noindex`. The password is *derived* — from a
cluster-wide salt and the environment's own identity — rather than generated and
stored, so CI can compute it and post it in the pull request comment without
ever holding cluster credentials. Whoever can read the pull request can open the
environment; whoever cannot, cannot. GitHub's permissions answer the access
question, and the platform keeps no user list of its own.

**It is checked before it is offered.** Once the environment answers, the
repository's own smoke tests run against the live URL and report as a check on
the pull request. So the reviewer is not handed a link and left to work out
whether anything is broken — merging is a decision backed by tests that ran
against a real deployment of that commit.

Applications that need data can ask for `database: true` and get an ephemeral
Postgres created and destroyed with the environment. That is the one place this
is straightforwardly better than the commercial platforms rather than equivalent
— they share one branch database across every preview, so two pull requests with
conflicting migrations corrupt each other's review.

### Preview environments are hostile by default

A preview environment runs unreviewed code, in many cases from a repository this platform's operator does not control. Treating that as trusted is the mistake this design is built around avoiding.

- **The chart comes from the platform, not the pull request.** It used to be read from the branch under review, which meant anyone able to open a pull request could add a ClusterRoleBinding to it and have ArgoCD apply it with ArgoCD's privileges. A pull request can now change what is deployed, never how.
- **ArgoCD's `default` project is not used.** It permits every repository, namespace and resource kind. Previews run under a project scoped to the chart repository, `*-pr-*` namespaces, and a resource list containing nothing that grants permissions.
- **Environments cannot reach each other.** A NetworkPolicy admits only the ingress controller and permits egress to DNS and the public internet with the private ranges carved out, including the link-local metadata service that hands instance credentials to anything that asks.
- **One environment cannot starve the rest.** A ResourceQuota caps each namespace and a LimitRange supplies defaults, so a pull request that leaks memory or asks for ten replicas is refused rather than allowed to take the node down.
- **The container holds nothing it does not need.** It runs as a fixed non-root UID on a read-only root filesystem with all capabilities dropped, and npm is deleted from the runtime image — nothing there invokes it, and its bundled dependencies were the source of every CRITICAL the image scan reported.
- **Egress is limited by port as well as by address.** Carving out the private ranges stops a preview reaching the cluster; it does nothing about a preview reaching *outward* on any port it likes, with the node's address as the source anyone abused by it would see. DNS, HTTP and HTTPS are what fetching a dependency needs. Sending mail, scanning SSH and holding a command-and-control channel on an arbitrary port are not.

None of that is asserted on trust. Every claim above is a behavioural assertion
in `scripts/e2e-test.sh`, run on a real cluster on every commit: a pod in
another namespace tries to reach the environment and is timed out, the metadata
service is requested from inside the pod and is not reachable, an oversized pod
is submitted and refused, a privileged pod is submitted and rejected by
admission. These used to be `kubectl get networkpolicy | grep -q .`, which an
empty policy passes.

### It measures itself

The promise is "open a pull request, get a working URL". That is an SLI, so it
is measured: seconds from the pull request opening to the environment serving
200, recorded per environment into `metrics/provisioning.jsonl` and reported
against an objective of 95% within 120 seconds.

Git is the datastore, which needs no time-series database on a node that cannot
afford one, and is the same argument the rest of the project makes about state.
`make slo` prints the current percentiles and how much error budget is left.

Failures are induced deliberately rather than only being waited for.
`make chaos` deletes the pod, deletes the Deployment, rolls out an image tag
that cannot exist, and deletes the Service — timing the recovery each time, and
asserting that a failing rollout never takes the environment down. It runs
weekly. `docs/runbook.md` lists the failures that happened by accident; this is
the other half.

## Components

| Piece | Choice | Reason |
|---|---|---|
| Cluster | k3s on a single Azure **Spot** VM | Nothing here needs managed Kubernetes, and one node keeps a student budget alive. Spot is a tenth of the price and is affordable only because the platform already rebuilds itself from git; a scheduled job on free GitHub runners restarts it after an eviction. See [docs/cost.md](docs/cost.md) for what each lever is worth |
| GitOps | ArgoCD + ApplicationSet PR generator | The PR generator is what makes per-PR environments declarative rather than scripted |
| CI | GitHub Actions | Builds and pushes images; never talks to the cluster directly |
| Registry | GHCR | Free for public images, native GitHub auth |
| Ingress | ingress-nginx | Routes every `<slug>-pr-<n>` hostname to the right namespace by Host header |
| DNS | nip.io | Wildcard hostnames with no domain to buy or configure |
| TLS | cert-manager + Let's Encrypt | Optional, staging issuer by default — preview hostnames churn past the production rate limit |
| Observability | Prometheus, no operator | Alerts on environments that never become healthy. Grafana and the operator are opt-in — they need four vCPU, which this node does not have |
| Alerting | GitHub Issues, polled by Actions | Alertmanager costs CPU this node has not got, and would still need a destination. An open issue is a firing alert, closed when it recovers |

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
scripts/chaos-test.sh                   Failures induced deliberately, recovery timed
scripts/slo-report.rb                   Provisioning latency against the objective
metrics/provisioning.jsonl              One measurement per environment, appended by CI
docs/decisions/                         Why it is shaped this way, and what was rejected
docs/capacity.md                        How many environments fit, and where each limit lives
docs/cost.md                            What it costs, and the three levers that matter
docs/onboarding.md                      How another repository adopts this
docs/runbook.md                         Every failure this platform has actually produced
```

The application in `app/` is deliberately trivial. It reports its own environment name, PR number, git SHA, and build time, so that opening a preview URL immediately proves *which* commit is running there. All of it arrives through environment variables set by CI and Kubernetes.


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
| Isolation is asserted, not assumed | A pod in another namespace is timed out reaching the environment, on every commit — not once, by hand |
| Quotas and admission refuse things | An oversized pod and a privileged pod are both submitted and both rejected, in CI |
| Previews are private | 401 without credentials; 200 with the password derived exactly as CI derives it; `X-Robots-Tag: noindex` on every response |
| A failing rollout does not take the environment down | An image tag that cannot exist is rolled out and the environment keeps serving throughout |
| Recovery is timed, not hoped for | Pod deleted, Deployment deleted, Service deleted — each restored, with the seconds recorded |
| Production verifies itself | The release is confirmed by `/api/info` reporting the promoted SHA, and reverted automatically if it never does |

Four bugs were found only by running this, and are fixed:

1. The image tag could never match, because GitHub Actions builds the PR's *merge* commit while ArgoCD asks for its *head*.
2. `kubectl apply` fails on ArgoCD's CRDs — they exceed the annotation size limit that client-side apply relies on.
3. nip.io reads `pr-1.127.0.0.1` as the address `1.127.0.0`, so every preview URL resolved somewhere else and timed out.
4. Namespaces survived pruning, because `CreateNamespace=true` creates them outside the set ArgoCD tracks.

Both of the gaps that needed a publicly reachable address are now closed. The platform runs on an Azure VM in `eastasia`, and both hostnames serve certificates issued by Let's Encrypt production — `curl` without `-k` succeeds, so a browser shows no warning.

## Using it

Two ways in, neither of which needs anyone's permission. Both are written up in
**[docs/onboarding.md](docs/onboarding.md)**.

**On this cluster** — add a workflow call and `.github/preview.yml` to your
repository, then give it the `pr-preview` topic. An hourly job finds
repositories carrying that topic and onboards them. No cloud account, no
Kubernetes, nobody to ask.

**On your own** — fork it, run `make init` to point the fork at itself, then
either `make dev-cluster` for a local one or `infra/azure` for a cloud VM.

```bash
make            # every target, with what it does
make validate   # everything checkable without a cluster
make e2e        # a preview environment on a throwaway cluster
make chaos      # break one on purpose, and time the recovery
make slo        # provisioning latency against the objective
```

When something breaks, **[docs/runbook.md](docs/runbook.md)** lists every
failure this platform has actually produced, written from the symptom inward.
