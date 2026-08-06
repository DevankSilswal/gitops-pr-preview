# Getting preview environments for your repository

Every pull request in your repository gets its own URL, running your branch,
created when the pull request opens and destroyed when it closes.

There are two ways in. The first needs no cloud account and no Kubernetes.

---

## A. Use an existing cluster

Someone already runs the platform and adds you to it. You need two things.

### 1. A Dockerfile

Your application has to build into an image and listen on a port. Nothing else
about it matters — language, framework, whether it has a database.

Two conventions make the environment badge work, and both are optional:

```dockerfile
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV GIT_SHA=$GIT_SHA BUILT_AT=$BUILT_AT
```

The platform also sets `ENVIRONMENT` and `PR_NUMBER` at runtime. An application
that ignores all four still works; one that displays them lets a reviewer see
at a glance which pull request they are looking at.

### 2. A workflow

`.github/workflows/preview.yml`:

```yaml
name: preview

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main]

jobs:
  preview:
    uses: DevankSilswal/gitops-pr-preview/.github/workflows/preview-build.yml@main
    permissions:
      contents: read
      packages: write
      pull-requests: write
      deployments: write
    with:
      image-name: my-app
      context: .
      preview-base-host: 20-24-211-179.nip.io
```

That is the whole integration. It builds your image for both architectures,
tags it the way the platform looks for, scans it, labels the pull request,
waits for the environment to answer, and then records a deployment and comments
the URL — checked, so the link works when a reviewer clicks it.

Useful inputs: `dockerfile` if it is not `<context>/Dockerfile`, `slug` if your
image name differs from the name you are onboarded under, and
`fail-on-vulnerabilities: false` if a failing scan should warn rather than
block.

### 3. Opt in — nobody needs to approve you

Add `.github/preview.yml` to your repository:

```yaml
port: 8080              # what your application listens on
healthPath: /healthz    # what the probes should ask for; defaults to /
image: my-app           # optional; defaults to the repository name
```

Then add the topic **`pr-preview`** to the repository (Settings, or the gear
beside About on the repository page).

That is all of it. An hourly job on the platform finds repositories carrying
that topic, reads this file, and onboards them. You do not ask anyone, and
nobody approves. Remove the topic or the file and your environments go away on
the next run.

Your environments appear at
`https://<owner>-<repo>-pr-<number>.<base-host>`.

The slug is derived from your owner and repository rather than chosen. With
onboarding open to anyone a chosen slug would be squattable — whoever asked for
`app` first would own it — and two repositories claiming the same one would end
up sharing an environment.

**Your repository must be public**, and its packages readable, since the
platform reads your pull requests and pulls your images without credentials of
yours.

### What you do not need

No Helm chart, no Kubernetes manifests, no `kubectl`, no cloud account. The
chart lives in the platform; your repository contributes an image and a pull
request. It also means a pull request cannot change how it is deployed — only
what is deployed — which is deliberate on a shared cluster.

---

## B. Run your own

Fork this repository, then point it at itself:

```bash
make init
git commit -am 'chore: point the platform at my fork'
git push
```

That matters more than it looks. A fork carries the original author's details,
and the consequential one is quiet: `deploy/platform/platform.yaml` decides
where ArgoCD fetches the chart. Leave it and your cluster keeps pulling charts
from somebody else's repository — which works, until they change it. `make
init` rewrites that, replaces the example onboarding with one for your own
repository, and repoints the production application.

Then the infrastructure. [`infra/azure/`](../infra/azure) builds a single VM
running k3s.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gitops -N ''

terraform -chdir=infra/azure init
terraform -chdir=infra/azure apply \
  -var subscription_id=$(az account show --query id -o tsv) \
  -var ssh_public_key="$(cat ~/.ssh/gitops.pub)"
```

Point `kubectl` at it, then:

```bash
export GITHUB_TOKEN=...            # fine-grained, read Contents + Pull requests
export ACME_EMAIL=you@example.com  # optional, for real certificates
./scripts/bootstrap-cluster.sh <public-ip>
```

Sizing matters more than it looks. Two vCPUs runs the platform and a handful of
environments; it does **not** also run the monitoring stack — see the header of
[`deploy/platform/observability/values.yaml`](../deploy/platform/observability/values.yaml)
for what happens when you try.

To try it with no cloud account at all:

```bash
make dev-cluster
make dev-bootstrap
```

---

## When an environment does not appear

Check the label first — an environment exists exactly while its pull request
carries `preview`, so no label means the platform is behaving correctly:

```bash
gh pr view <n> --json labels
```

If the label is there and the URL is not,
[`docs/runbook.md`](runbook.md) lists every failure this platform has actually
produced, starting from what each one looks like from the outside.

## Limits, and what happens when you reach them

**Your repository gets five environments at once** by default. Past that, a
pull request is told so and waits for one to free up. Raise it with
`max-environments` if the operator has capacity, or add the label by hand to
take a slot.

**The cluster serves ten repositories** by default. An eleventh is skipped,
with the reason in the discovery run's summary.

Those two multiply, and the product is what the node has to hold. A shared
2-vCPU node holds roughly 58 environments requesting what the sample
applications request — or four requesting the per-namespace ceiling. If your
application is heavy, expect to be the one that fills it.

**When it is full, new pods stay Pending.** The scheduler refuses new work
rather than evicting a running environment, so a full cluster denies new
environments instead of breaking existing ones.

**TTL expiry is per-repository.** The platform cannot manage labels in a
repository it does not own. Copy `preview-lifecycle.yml` into yours to get
automatic expiry; without it, closing pull requests is what frees capacity.

**Pull requests from forks get no environment.** A fork's token cannot publish
images, and building fork code with a token that could would hand an unreviewed
branch the ability to push to the registry.
