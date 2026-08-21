#!/usr/bin/env bash
# Refuse a configuration that could destroy the production node.
#
# The OS disk is declared inline in azurerm_linux_virtual_machine.k3s, so
# destroying that resource destroys k3s, ArgoCD, every preview environment and
# the control plane database. On 2026-08-20 a plan wanted to do exactly that,
# over drift that had nothing to do with the change being made — the config said
# Spot while the machine was Regular, and custom_data had moved.
#
# prevent_destroy stops the apply. This stops the removal of prevent_destroy,
# which is the only way the apply becomes possible again by accident.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VM_FILE="$REPO_ROOT/infra/azure/main.tf"

fail() { echo "FAIL: $*" >&2; exit 1; }

grep -q "prevent_destroy = true" "$VM_FILE" \
  || fail "azurerm_linux_virtual_machine.k3s has no prevent_destroy.
      The OS disk is inline in that resource, so a plan that replaces the VM
      destroys k3s, ArgoCD, every environment and the control plane database.
      Removing the guard is a deliberate act and belongs in its own commit with
      a reason, not in a change that happens to touch this file."
echo "  ok: the production VM cannot be destroyed by an apply"

grep -q "ignore_changes = \[custom_data\]" "$VM_FILE" \
  || fail "custom_data is not ignored.
      cloud-init runs once at first boot, so editing it changes nothing about a
      running machine — but Terraform treats it as replacement-forcing, which
      means a comment edit can propose destroying the cluster."
echo "  ok: a cloud-init edit cannot force a replacement"

# The two defaults that described a machine this project does not run. Both
# would have been applied silently by anyone running terraform apply.
vars="$REPO_ROOT/infra/azure/variables.tf"
# ^[[:space:]]*default anchors to the assignment, not to the word appearing in
# a comment — which the first version of this line did, and reported the
# correct value as wrong.
spot_default=$(awk '/variable "use_spot"/,/^}/' "$vars" | awk -F= '/^[[:space:]]*default[[:space:]]*=/ {gsub(/[ "]/,"",$2); print $2}')
[[ "$spot_default" == "false" ]] \
  || fail "use_spot defaults to '$spot_default'; the live VM is Regular.
      Applying that default replaces the machine."
echo "  ok: use_spot matches the running machine"

shutdown_default=$(awk '/variable "auto_shutdown_time"/,/^}/' "$vars" | awk -F= '/^[[:space:]]*default[[:space:]]*=/ {gsub(/[ "]/,"",$2); print $2}')
[[ -z "$shutdown_default" ]] \
  || fail "auto_shutdown_time defaults to '$shutdown_default'; no such schedule exists in Azure.
      Applying it would start deallocating production every night, which the
      permanent demo exists to not do."
echo "  ok: no nightly shutdown would be created"

echo "terraform guards are in place"
