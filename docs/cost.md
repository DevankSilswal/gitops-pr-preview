# What this costs to run

Every architectural decision here was made under one constraint: it has to
survive on a student credit, and then on nothing. That constraint is the reason
for several choices that would otherwise look strange — spot capacity for
something with a public URL, no Alertmanager, monitoring polled from GitHub
rather than run on the node.

Figures are `eastasia`, and list prices move; the ratios are what matter.

## Where the money goes

| Resource | On demand | As configured | Why |
|---|---:|---:|---|
| `Standard_B2als_v2` VM | ~$30/mo | **~$3/mo** | Spot capacity, plus deallocated overnight |
| OS disk, 32 GB `Standard_LRS` | ~$1.50/mo | ~$1.50/mo | Cheapest tier. Nothing here is IO-bound |
| Static public IP (Standard) | ~$3.65/mo | ~$3.65/mo | Not optional — preview hostnames encode the address |
| Blob storage for Terraform state | pennies | pennies | Kilobytes |
| Egress | free tier | free | First 100 GB/month |
| GitHub Actions | free | free | Public repository |
| GHCR | free | free | Public images |

**Compute is the whole bill.** The disk and the IP together cost less than two
days of the VM running on demand, so every saving worth making is a saving on
hours the VM is powered.

## The three levers, in order of what they are worth

### 1. Spot capacity — roughly 90% off

`use_spot = true` in `infra/azure/variables.tf`. Azure sells unused capacity at
a steep discount and can reclaim it with 30 seconds' notice.

This is normally an unacceptable trade for anything serving a URL. It is
acceptable here for a reason specific to this platform, and it is the reason
worth understanding: **the cluster already rebuilds itself from git**. The VM
has been destroyed and recreated with production and every preview environment
restored by `bootstrap-cluster.sh` alone, and the public IP is static so no
hostname changes. An eviction is an easier version of that — `eviction_policy =
"Deallocate"` keeps the disk, so k3s comes back with its own state and ArgoCD
reconciles the rest.

`max_bid_price = -1` means paying up to the on-demand price and never being
evicted over price, only when the region genuinely needs the capacity back.

What was missing was never recovery. It was *noticing*: a deallocated VM does
not restart itself. `.github/workflows/spot-watchdog.yml` polls every ten
minutes and starts it, on runner minutes that cost nothing — which is also why
it runs there rather than on the node it is watching.

### 2. Nightly deallocation — roughly 50% off what remains

`azurerm_dev_test_global_vm_shutdown_schedule` is free and deallocates the VM
each night. A cluster demonstrated a few hours a week and up 24/7 is paying for
nothing the rest of the time, and `make azure-stop` only helps on days somebody
remembers.

Nothing is lost. ArgoCD reconciles the whole fleet from git on the way back up.
The watchdog knows about the window and will not undo it — see `QUIET_HOURS_*`.

### 3. Size — the smallest lever, and the one people reach for first

| Size | vCPU / RAM | Verdict |
|---|---|---|
| `Standard_B2als_v2` | 2 / 4 GB | What is used. Holds k3s, ArgoCD and Prometheus together |
| `Standard_B2ats_v2` | 2 / 1 GB | Cheaper, and ArgoCD alone does not fit in 1 GB |
| `Standard_B1ms` | 1 / 2 GB | Half the burn, and the repo-server and Prometheus contend for the one core badly enough that provisioning misses its SLO |

Downsizing saves less than either lever above and costs capability. Deallocating
a right-sized VM beats running an undersized one continuously.

## Decisions the constraint forced

These are worth reading as a set, because each one traded something real:

- **No Alertmanager.** It costs CPU on a node with none spare, and would still
  need somewhere to send alerts. `alerts-to-issues.yml` polls Prometheus from a
  GitHub runner and opens an issue instead — free minutes, and the alerts land
  in the same repository as everything else. An open issue is a firing alert.
- **No Grafana, no Prometheus operator.** Tried twice, took the node down both
  times. ADR 0004 has the measurements.
- **No oauth2-proxy for private previews.** Real GitHub identity per
  environment is the better product and does not fit. Basic auth with a derived
  password, delivered in the pull request comment, uses no node resources at
  all. ADR 0006.
- **`emptyDir`, not PVCs, for preview databases.** A volume per pull request on
  a single node is not available at any price, and a preview database should be
  reconstructible from migrations anyway.
- **Git as the metrics store.** No time-series database for the platform's own
  SLI. `metrics/provisioning.jsonl` is appended to by CI and read by
  `scripts/slo-report.rb`.

## One-time setup for the free parts

The spot watchdog needs Azure credentials on a GitHub runner, via OIDC
federation — no client secret, nothing to rotate:

```bash
# An app registration federated to this repository
az ad app create --display-name gitops-preview-ci
az ad app federated-credential create --id <app-id> --parameters '{
  "name": "github",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<owner>/<repo>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
az role assignment create --assignee <app-id> \
  --role "Virtual Machine Contributor" \
  --scope /subscriptions/<sub>/resourceGroups/gitops-k3s-rg

gh variable set AZURE_CLIENT_ID       --body '<app-id>'
gh variable set AZURE_TENANT_ID       --body '<tenant-id>'
gh variable set AZURE_SUBSCRIPTION_ID --body '<subscription-id>'
```

Leaving `AZURE_CLIENT_ID` unset disables the watchdog rather than failing it.

## Turning it all off

```bash
make azure-stop     # deallocate; keeps the disk and the IP, stops compute charges
make azure-down     # destroy everything
```

`azure-stop` is the one that matters day to day. Stopping the VM from inside
the guest does **not** work — Azure keeps billing a machine it still has
reserved.
