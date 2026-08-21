# Terraform and this cluster now agree

As of 2026-08-21 the plan is non-destructive:

```
Plan: 0 to add, 1 to change, 0 to destroy.
  # azurerm_network_security_group.main will be updated in-place
```

The one remaining change is a tightening: the live NSG allows SSH and the
Kubernetes API from `*`, and the configuration refuses `0.0.0.0/0` outright, so
an apply would restrict them to whatever address is named at the time. That is
an improvement and it is not applied here.

Three defaults described a machine this project does not run, and each would
have been applied silently:

| variable | said | reality | consequence of applying |
|---|---|---|---|
| `use_spot` | `true` | Regular | VM replaced |
| `auto_shutdown_time` | `"2000"` | no schedule exists | production deallocated nightly |
| `custom_data` | drifted | boot-time only | VM replaced over a comment edit |

`custom_data` is now ignored, because cloud-init runs once at first boot and an
edit afterwards changes nothing about a running machine. The VM carries
`prevent_destroy`, and `scripts/check-terraform-guard.sh` fails CI if that is
removed or if either default drifts back.

---

## What this section used to say, and why it is kept

The configuration here and the live infrastructure had diverged, and Terraform
resolved that divergence by **destroying the VM**:

```
# azurerm_linux_virtual_machine.k3s must be replaced
  ~ custom_data      = (sensitive value) # forces replacement
  + eviction_policy  = "Deallocate"      # forces replacement
  ~ priority         = "Regular" -> "Spot" # forces replacement
Plan: 2 to add, 0 to change, 1 to destroy.
```

The OS disk is declared inline in that resource, so replacing the VM destroys
k3s, ArgoCD, every preview environment, the control plane database and the
production namespace. The static IP and the NIC survive, so the hostnames would
come back — pointing at an empty cluster.

None of those three fields is a size change. The live VM is `Regular`; this
configuration asks for `Spot`. That drift has existed since before 2026-08-13
and is the same one recorded in `docs/runbook.md`.

## Changes Azure can make in place

Changes that Azure can make in place — resizing, in particular — go through the
CLI, and the corresponding variable here is updated to match so the declared
size and the real one agree:

```bash
az vm resize -g gitops-k3s-rg -n gitops-k3s --size Standard_B2as_v2
```

That is how the 4 GB → 8 GB move on 2026-08-20 was done. It preserved the OS
disk, the NIC, the static IP and all cluster state, and cost about three and a
half minutes of downtime.

## Reconciling it properly

Either decide the VM should be Spot and accept a rebuild at a planned time — the
bootstrap does restore everything from git — or change this configuration to
describe what actually runs. Doing neither leaves a `terraform apply` that
destroys production sitting in the repository, which is why this file exists.
