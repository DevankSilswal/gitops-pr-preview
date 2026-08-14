#!/usr/bin/env bash
# Bring the generated hostname back in line with the infrastructure that owns it.
#
#   ./scripts/sync-base-host.sh            # read Azure, show what would change
#   ./scripts/sync-base-host.sh --write    # read Azure, update the generated file
#
# The address belongs to azurerm_public_ip.main. Everything else that mentions
# it is downstream, and this script is the only thing allowed to write it down.
# Before this existed the same value was maintained by hand in the platform
# chart, in a GitHub repository variable, and in whatever argument somebody last
# passed to bootstrap-cluster.sh — three copies that agreed only because the VM
# had never been replaced.
#
# It refuses rather than falls back. A default here would be the production
# address hidden inside the tool meant to remove production addresses.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES="$REPO_ROOT/deploy/platform-chart/values.yaml"
WRITE=false
[[ "${1:-}" == "--write" ]] && WRITE=true

# Terraform state first, because it is the source of truth for what this
# platform intends. Azure is asked only if state is unavailable — it reports
# what exists, which is the right answer to a different question, and is used
# here as a read-only cross-check rather than as the primary source.
ip=""
if terraform -chdir="$REPO_ROOT/infra/azure" output -raw public_ip >/dev/null 2>&1; then
  ip="$(terraform -chdir="$REPO_ROOT/infra/azure" output -raw public_ip)"
  source_of_truth="terraform output public_ip"
elif command -v az >/dev/null 2>&1; then
  ip="$(az network public-ip list -g gitops-k3s-rg --query '[0].ipAddress' -o tsv 2>/dev/null || true)"
  source_of_truth="az network public-ip (terraform state unavailable)"
fi

if [[ -z "$ip" ]]; then
  cat >&2 <<'EOF'
Could not read the public IP from Terraform state or from Azure.

This script will not guess. The generated hostname exists so that no copy of the
production address is maintained by hand, and writing one here from a default
would put it back in the one place nobody would think to look.

  cd infra/azure && terraform init && terraform output -raw public_ip
  az login   # if Terraform state is not available locally
EOF
  exit 1
fi

generated="$(node "$REPO_ROOT/scripts/base-host.js" "$ip")"
current="$(awk '/^baseHost:/ { print $2; exit }' "$VALUES")"

echo "source:    $source_of_truth"
echo "address:   $ip"
echo "generated: $generated"
echo "in git:    ${current:-<absent>}"

if [[ "$generated" == "$current" ]]; then
  echo "already in sync"
  exit 0
fi

if [[ "$WRITE" != true ]]; then
  echo
  echo "OUT OF SYNC — run with --write to update $VALUES, then commit it."
  echo "Anything already deployed keeps its old hostname until ArgoCD syncs the"
  echo "change and cert-manager issues a certificate for the new one."
  exit 2
fi

tmp="$(mktemp)"
awk -v v="$generated" '/^baseHost:/ { print "baseHost: " v; next } { print }' "$VALUES" > "$tmp"
mv "$tmp" "$VALUES"
echo "updated $VALUES"
echo
echo "Still to do, deliberately not automated:"
echo "  1. commit the change — ArgoCD deploys from git, not from this laptop"
echo "  2. gh variable set PREVIEW_BASE_HOST --body '$generated'"
echo "  3. re-run bootstrap-cluster.sh so the ApplicationSet and any wildcard"
echo "     certificate pick up the new hostname; both are bootstrap-owned"
