# Runbook

Every failure listed here has actually happened while building this platform.
Each entry says what it looks like from the outside first, because that is all
you have when it starts.

## A pull request has no preview environment

Check what the label says before checking the cluster — the label is the
desired state, so if it is missing, the cluster is behaving correctly.

```bash
gh pr view <n> --json labels
```

Note that `gh pr list --label preview` reads GitHub's search index, which lags
by minutes. When it disagrees with reality, believe the API:

```bash
gh api repos/<owner>/gitops-pr-preview/pulls/<n> --jq '[.labels[].name]'
```

No label, and a comment on the pull request explaining why, means one of:

- **It came from a fork.** Fork builds get a read-only token and cannot publish
  the image, so no environment is granted. Push the branch to this repository
  to get one.
- **The cap is full.** `MAX_ENVIRONMENTS` environments are already running.
  Close a stale pull request, or add the label by hand to take a slot.
- **A bot opened it.** Dependency bumps are skipped deliberately.

No label and no comment usually means the workflow never ran — check
`gh run list --workflow=preview-lifecycle.yml`.

## The environment exists but the URL returns nothing

```bash
kubectl get application preview-pr-<n> -n argocd
kubectl get pods -n pr-<n>
kubectl describe pod -n pr-<n> <pod>
```

**`ImagePullBackOff` with `not found`** — the tag ArgoCD asked for was never
published. CI tags with the pull request's *head* SHA; a build that ran against
the merge commit produces a different tag and nothing lines up. Compare:

```bash
gh pr view <n> --json headRefOid --jq .headRefOid
kubectl get deploy -n pr-<n> -o jsonpath='{.items[0].spec.template.spec.containers[0].image}'
```

**`ImagePullBackOff` with `no match for platform`** — the image exists but not
for this node's architecture. Images are built for `linux/amd64` and
`linux/arm64`; an older single-architecture image will not run on the other.

```bash
docker manifest inspect <image> | grep architecture
```

**Pod `Running` but not `Ready`** — the readiness probe on `/api/health` is
failing. `kubectl logs -n pr-<n> <pod>`.

**Pod ready, URL still dead** — the ingress rule may not be programmed yet;
ingress-nginx answers with its own 404 page in the meantime, so a response is
not proof of anything. Confirm the host matches exactly:

```bash
kubectl get ingress -n pr-<n>
```

## The URL resolves to the wrong address

nip.io splits hostnames on dashes as well as dots, so `pr-1.10.0.0.1.nip.io`
resolves to `1.10.0.0`. Addresses must be written in dash form —
`pr-1.10-0-0-1.nip.io`. Check with `dig +short <host>`.

## A closed pull request left something behind

Deleting the Application should cascade to the namespace, because the chart
owns it. If a namespace lingers, it was created outside the release — the
`CreateNamespace=true` sync option does that, which is why it is not used here.

```bash
kubectl get ns | grep '^pr-'
kubectl get application -n argocd
```

## The certificate is untrusted

```bash
echo | openssl s_client -connect <ip>:443 -servername <host> 2>/dev/null \
  | openssl x509 -noout -issuer
```

`(STAGING)` in the issuer means the staging ACME endpoint, whose certificates
browsers reject. Bootstrap defaults to production; `ACME_STAGING=1` opts back
into staging while iterating.

`Kubernetes Ingress Controller Fake Certificate` means cert-manager never
issued one — check `kubectl describe certificate -n pr-<n>` and the Order and
Challenge resources beneath it. HTTP-01 validation requires the host to be
reachable from the internet; it cannot work against a private address.

## kubectl cannot reach the cluster

```
certificate is valid for 10.0.1.4, 10.43.0.1, 127.0.0.1, not <public ip>
```

k3s signs its API certificate for the addresses it knew at install time.
cloud-init templates the public address into `tls-san`, so this means the node
was built before that was in place. Fix in place with:

```bash
printf "tls-san:\n  - <public-ip>\n" | sudo tee /etc/rancher/k3s/config.yaml
sudo rm -f /var/lib/rancher/k3s/server/tls/serving-kube-apiserver.{crt,key}
sudo systemctl restart k3s
```

## Terraform will not create the VM

**`SkuNotAvailable ... Capacity Restrictions`** — that size is out of stock in
that region. Try another size or region.

**`RequestDisallowedByAzure`** — the subscription may only deploy to certain
regions. Ask it which:

```bash
az policy assignment list \
  --query "[?displayName=='Allowed resource deployment regions'].parameters"
```

**`SkuNotAvailable` for everything, or empty quota output** — the resource
providers may not be registered on a new subscription:

```bash
az provider register -n Microsoft.Compute
az provider register -n Microsoft.Network
```

## Production is not updating

Releases are commits: CI writes the tag into
`charts/preview-app/values-production.yaml` and ArgoCD deploys what it finds
there. If production looks stale, read that file — it is the record of what
should be running.

A tag of `latest` is always wrong here. CI never publishes it, so the pod will
sit in `ImagePullBackOff` indefinitely.

## The cluster is costing money while nobody is looking

```bash
make azure-stop    # deallocates; keeps the disk and the static IP
make azure-start
```

Stopping the machine from inside the guest does not stop billing — Azure keeps
charging for a VM it still has reserved. Only deallocation does.

## The whole cluster stops responding

`kubectl` times out, SSH times out, and the preview URLs go down together. If
the Azure control plane still answers, the machine is up and something inside
it is starving everything else.

```bash
az vm restart -g gitops-k3s-rg -n gitops-k3s
# then, as soon as it answers:
ssh ubuntu@<ip> "uptime; sudo k3s kubectl get pods -A"
```

Load average is the tell. On a 2-vCPU node anything above about 4 means work is
queueing; this has been seen at 19, at which point the API server cannot answer
its own health checks and everything looks broken at once.

The cause here was installing kube-prometheus-stack onto the node that runs
everything else. Nothing was OOMKilled — it was purely CPU. Recovery is to
delete the namespace from the rebooted node before the pods reschedule:

```bash
ssh ubuntu@<ip> "sudo k3s kubectl delete ns monitoring --wait=false"
```

kube-prometheus-stack needs four vCPU or a node of its own. On a smaller node
use `WITH_OBSERVABILITY=1`, which installs Prometheus without the operator or
Grafana and holds load near idle; `WITH_OBSERVABILITY=full` is the heavy one.
See the header of `deploy/platform/observability/values-lite.yaml`.

## Terraform says the state is locked

```
Error acquiring the state lock: state blob is already locked
```

A previous run was interrupted before it could release the lease. Confirm
nothing is actually running, then break it:

```bash
KEY=$(az storage account keys list -n <storage-account> -g gitops-tfstate-rg --query "[0].value" -o tsv)
az storage blob lease break -c tfstate -b azure.tfstate --account-name <storage-account> --account-key "$KEY"
```

`terraform force-unlock <id>` does the same thing when the error reports an ID.

## Rotating the GitHub token ArgoCD uses

The pull request generator needs to read pull requests and nothing else. A
token with `repo` scope — which is what `gh auth token` hands out — lets
anything that reaches the cluster write to the repository, including its
workflows. Use a fine-grained token instead.

Create it at **github.com/settings/personal-access-tokens/new**:

- **Repository access**: Only select repositories → this repository
- **Repository permissions**: `Contents: Read-only` and
  `Pull requests: Read-only`, nothing else. `Metadata: Read-only` selects
  itself and cannot be removed; that is expected.

Then put it in the cluster without it passing through a shell history or a
chat window:

```bash
pbpaste | tr -d '\n' > /tmp/tok.txt        # macOS, straight from the clipboard
kubectl -n argocd delete secret github-token
kubectl -n argocd create secret generic github-token --from-file=token=/tmp/tok.txt
rm /tmp/tok.txt
```

The trailing newline matters: leave it in and GitHub rejects every request with
a 401, which surfaces as the ApplicationSet quietly generating nothing.

Confirm it took:

```bash
kubectl logs -n argocd deploy/argocd-applicationset-controller --tail=20 | grep generated
```

It should report the number of pull requests currently carrying the `preview`
label. Zero, when labelled pull requests exist, means the token is wrong.

## New environments stay Pending

```bash
kubectl get pods -A --field-selector status.phase=Pending
kubectl describe node <node> | grep -A6 'Allocated resources'
```

`Insufficient cpu` or `Insufficient memory` in the pod's events means the node
is full. This is the intended failure: the scheduler refuses new work rather
than evicting somebody's running environment.

Capacity is bounded in two places, and the worst case is their product:

- `MAX_REPOS` in the discover workflow — how many repositories are served
- `max-environments` in the reusable build workflow — how many each may hold

Both default low enough for applications that request what the samples do. One
application requesting the per-namespace ceiling takes a quarter of a 2-vCPU
node on its own, so a few of those will fill it whatever the counts say.

To recover: close stale pull requests, lower the TTL, offboard a repository by
removing its file from `deploy/platform/onboarded/`, or give the node more
CPU. Watch it with the `TooManyPreviewEnvironments` alert rather than by
noticing.

## The alerts are green and you do not believe them

An alert that matches no series reports itself `inactive`, exactly as one that
is watching something healthy does. That has happened here: the alerts were
scoped to `pr-*` namespaces and namespaces became `<slug>-pr-<number>`.

Check the expression matches anything at all:

```bash
kubectl port-forward -n monitoring svc/monitoring-prometheus-server 9090:80
curl -s --data-urlencode 'query=count(kube_pod_info{namespace=~".+-pr-[0-9]+"})' \
  localhost:9090/api/v1/query
```

`NO DATA` there means the alerts are watching nothing, whatever they say about
themselves. To prove the path end to end, break something on purpose:

```bash
kubectl create ns broken-pr-1
kubectl -n broken-pr-1 create deployment broken --image=example.com/nope:nope
# PreviewImagePullFailing goes pending, then firing after ten minutes
kubectl delete ns broken-pr-1
```
