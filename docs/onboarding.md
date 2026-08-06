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
    with:
      image-name: my-app
      context: .
      preview-base-host: 20-24-211-179.nip.io
```

That is the whole integration. It builds your image for both architectures,
tags it the way the platform looks for, scans it, labels the pull request, and
comments the preview URL.

Useful inputs: `dockerfile` if it is not `<context>/Dockerfile`, `slug` if your
image name differs from the name you are onboarded under, and
`fail-on-vulnerabilities: false` if a failing scan should warn rather than
block.

### 3. One file in the platform repository

Open a pull request adding `deploy/platform/onboarded/my-app.yaml`:

```yaml
slug: my-app            # appears in namespaces and URLs; must match the filename
owner: your-username
repo: your-repo
image: ghcr.io/your-username/my-app
port: "8080"            # quoted — it reaches ArgoCD as a string
healthPath: /healthz    # what the probes should ask for
```

That is the entire onboarding. ArgoCD reads that directory from git itself, so
merging the pull request is what turns your environments on — nobody runs
anything against the cluster. Deleting the file turns them off again, along
with every environment you had.

CI checks the file on the pull request: a slug that is not a valid DNS label,
an unquoted port, a duplicate, or a filename that disagrees with its slug all
fail there rather than becoming an environment that silently never appears.

The platform's GitHub token also has to be able to read pull requests in your
repository — automatic for a public one.

Your environments then appear at `https://my-app-pr-<number>.<base-host>`.

### What you do not need

No Helm chart, no Kubernetes manifests, no `kubectl`, no cloud account. The
chart lives in the platform; your repository contributes an image and a pull
request. It also means a pull request cannot change how it is deployed — only
what is deployed — which is deliberate on a shared cluster.

---

## B. Run your own

Terraform for Azure and Oracle Cloud is in [`infra/`](../infra). Either one
builds a single VM running k3s.

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

## Known limits

- **The cluster-wide cap is not enforced across repositories.** The lifecycle
  workflow caps concurrent environments in the repository it runs in; it cannot
  see other repositories. On a shared cluster the `TooManyPreviewEnvironments`
  alert is what catches capacity filling up.
- **TTL expiry is per-repository** for the same reason. An adopting repository
  can add its own copy of `preview-lifecycle.yml` to get it.
- **Pull requests from forks get no environment.** A fork's token cannot
  publish images, and building fork code with a token that could would hand an
  unreviewed branch the ability to push to the registry.
