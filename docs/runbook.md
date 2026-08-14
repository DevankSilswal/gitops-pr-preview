# Runbook

Every failure listed here has actually happened while building this platform.
Each entry says what it looks like from the outside first, because that is all
you have when it starts.

## The node's address changed, or the VM was replaced

Every hostname this platform serves is `<something>.<address-in-dashes>.nip.io`,
so the address changing renames every URL at once. What survives is worth
knowing before the panic:

| Resource | Terraform | Survives VM replacement | Effect |
|---|---|---|---|
| Public IP | `azurerm_public_ip.main`, **Static**, Standard SKU | **Yes** — a separate resource from the VM | hostnames do not change |
| NIC | `azurerm_network_interface.main` | **Yes** — separate resource | — |
| OS disk | inline `os_disk` in `azurerm_linux_virtual_machine.k3s` | **No** — destroyed with the VM | k3s, ArgoCD and every environment are gone |
| k3s state | on that disk | No | rebuilt by bootstrap |
| ArgoCD state | on that disk | No | rebuilt from git by bootstrap |
| Demo URL | derived from the IP | **Yes**, provided the IP resource is not destroyed | — |

So the ordinary case — `terraform apply` replacing the VM — keeps every URL and
loses the cluster, which the bootstrap rebuilds from git. The case that renames
everything is destroying the public IP resource itself, which only happens on a
full `terraform destroy` or if someone removes it from the configuration.

If the address does change:

```bash
./scripts/sync-base-host.sh            # what Terraform says vs what git says
./scripts/sync-base-host.sh --write    # update the generated value
git commit -am 'chore: new node address'   # ArgoCD deploys from git, not from here
gh variable set PREVIEW_BASE_HOST --body "$(awk '/^baseHost:/ {print $2}' deploy/platform-chart/values.yaml)"
./scripts/bootstrap-cluster.sh         # ApplicationSet and wildcard are bootstrap-owned
```

Certificates do not follow automatically: cert-manager holds certificates for
the old hostnames and will request new ones the first time an Ingress asks for
the new ones. Expect a minute or two of untrusted TLS on each host while that
happens, and note that Let's Encrypt's rate limit is per registered domain —
`nip.io` — and shared with everybody else using it.

**What does not happen:** nothing detects the change. There is no watchdog on
the address, and `spot-watchdog.yml` — which would have been the place — has
completed as `skipped` on every run since it reached `main`, because it is gated
on an Actions variable this repository does not have.

## The permanent demo is down, and what will and will not fix itself

`demo.<base>` is an ArgoCD Application of its own — `preview-app-demo`, defined
in `deploy/argocd/application-demo.yaml`. It is not a pull request and carries no
`preview` label, so neither the ApplicationSet nor the TTL sweep can remove it.

What recovers without a human, and what does not, measured rather than assumed:

| Failure | Detected by | Recovers by itself | Time | URL changes |
|---|---|---|---|---|
| Pod deleted or OOM-killed | Deployment controller | **Yes** | seconds | no |
| Deployment or Service deleted | ArgoCD `selfHeal` | **Yes** | under ~3 min | no |
| Namespace deleted | ArgoCD `selfHeal` + `CreateNamespace` | **Yes** | under ~3 min | no |
| Node rebooted | k3s systemd unit, enabled at install | **Yes** | ~2 min after boot | no |
| **VM stopped or deallocated** | **nothing** | **No** | until a human runs `az vm start` | no |
| VM destroyed and recreated | nothing | No — `terraform apply` then `bootstrap-cluster.sh` | tens of minutes | no, if the static IP is reattached |

The two rows that matter are the ones in bold, and both are worse than this
repository used to claim.

**Nothing detects a stopped VM.** `spot-watchdog.yml` exists for exactly this and
runs every ten minutes, but its job is gated on `vars.AZURE_CLIENT_ID`, which is
not set — this repository has no Actions secrets at all, so the federated Azure
app registration it needs was never created. Every run since the workflow reached
`main` on 2026-08-13 has completed as `skipped`. A green run history and an inert
watchdog look identical from the outside, which is the failure mode this entry
exists to name.

**The VM is not Spot.** `az vm show` reports `priority: Regular` and
`evictionPolicy: null`. `docs/cost.md` and ADR 0008 describe spot capacity that
the live VM does not use, so the eviction the watchdog was written to catch
cannot occur as currently configured, and the bill is on-demand rather than the
figure in that document.

What genuinely holds: the public IP is `Static`/Standard SKU, so stopping and
starting the VM does not change it and no hostname moves. The disk survives, k3s
comes back on boot, and ArgoCD reconciles the workloads from git afterwards.

```bash
# is it the VM, or something inside it?
az vm get-instance-view -g gitops-k3s-rg -n gitops-k3s \
  --query "instanceView.statuses[?starts_with(code,'PowerState')].displayStatus" -o tsv

# if it is deallocated — this is the human step nothing performs for you
az vm start -g gitops-k3s-rg -n gitops-k3s

# then watch it come back on its own
until kubectl get nodes 2>/dev/null | grep -q ' Ready'; do sleep 10; done
kubectl get applications -n argocd
curl -o /dev/null -w '%{http_code}\n' https://demo.20-24-211-179.nip.io/
```

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

## Every URL is down and nothing was deployed

The node runs on spot capacity, so Azure can reclaim it. That is the first
thing to check, because it looks exactly like a cluster that has broken:

```bash
az vm get-instance-view -g gitops-k3s-rg -n gitops-k3s \
  --query "instanceView.statuses[?starts_with(code,'PowerState/')].code" -o tsv
```

`PowerState/deallocated` means an eviction, or the nightly shutdown doing its
job. `.github/workflows/spot-watchdog.yml` starts it again within ten minutes,
outside the quiet window — check that workflow's recent runs before starting it
by hand. If the watchdog is not running at all, `AZURE_CLIENT_ID` is probably
unset, which disables it silently by design.

Nothing needs redeploying afterwards. k3s comes back with its own state and
ArgoCD reconciles the fleet from git; that is the property that makes spot
affordable in the first place ([ADR 0008](decisions/0008-spot-capacity.md)).

If it is running and still serving nothing, it is not the spot instance and the
rest of this runbook applies.

## The preview password does not work

The password is derived on both sides rather than stored: the chart computes it
from the cluster salt, and CI computes the same value to post it. If a reviewer
is told a password that gets a 401, the two sides are using different salts.

```bash
# what the cluster has
kubectl -n argocd get secret preview-secret-salt -o jsonpath='{.data.salt}' | base64 -d
```

Compare against the `PREVIEW_SECRET_SALT` repository secret. The usual cause is
the cluster having been rebuilt with a new salt without the secret being
updated — `bootstrap-cluster.sh` reads an existing salt back rather than
regenerating it precisely so this does not happen, but a cluster rebuilt from
nothing has nothing to read back.

A comment saying the environment is **open to anyone with the link** means CI
had no salt at all, so the chart turned auth off rather than deriving a
password from an empty value.

## The environment is up but the comment says it is not answering

The health check runs with the preview credentials, so this can mean the
environment is fine and the password is wrong — see above — rather than that
the environment is down. Check by hand with the credentials from the comment:

```bash
curl -sSI --user preview:<password> https://<slug>-pr-<n>.<base>/ | head -1
```

A `401` confirms it is the salt. A `503` or a timeout is a real problem, and
`kubectl -n <slug>-pr-<n> describe pod` is the next step.

## Production rolled itself back

`verify-production` polls `/api/info` until the live deployment reports the
commit that was just promoted, and reverts the release commit if it never does.
An automatic revert means one of three things:

- ArgoCD never synced — check the Application's status
- the rollout never completed — `kubectl -n production rollout status deploy/...`
- it came up and the smoke tests failed against it, which is the interesting case

The revert restores the previous image, so production is serving something that
worked. `git log` on `charts/preview-app/values-production.yaml` shows both the
release and the revert, and the workflow run summary says which check failed.

## An `[alert]` issue appeared

That is the alerting path working. Issues labelled `alert` are opened by
`alerts-to-issues.yml` while a Prometheus alert is firing and closed
automatically when it stops — the issue title carries the alert name and the
namespace it fired for.

An issue that will not close means the alert is still firing. An alert firing
with nothing wrong usually means the expression matches namespaces it should
not; see "the alerts are green and you do not believe them" above, which is the
same problem in the other direction.
