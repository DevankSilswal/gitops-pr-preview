# Do not run `terraform apply` against this cluster yet

The configuration here and the live infrastructure have diverged, and Terraform
resolves that divergence by **destroying the VM**:

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

## What to do instead, until it is reconciled

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
