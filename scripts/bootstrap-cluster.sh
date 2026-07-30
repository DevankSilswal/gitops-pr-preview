#!/usr/bin/env bash
#
# One-shot cluster setup. Run once against a fresh k3s node, after `terraform
# apply` and after KUBECONFIG points at the cluster.
#
#   export GITHUB_TOKEN=github_pat_...
#   ./scripts/bootstrap-cluster.sh <github-owner> <node-public-ip>
#
# Installs ingress-nginx and ArgoCD, gives ArgoCD a token to read pull requests,
# then applies the ApplicationSet. From that point on nothing here is run again:
# opening a PR is the only action needed to create an environment.

set -euo pipefail

OWNER="${1:-}"
NODE_IP="${2:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$OWNER" || -z "$NODE_IP" ]]; then
  echo "usage: $0 <github-owner> <node-public-ip>" >&2
  exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN is not set." >&2
  echo "Create a fine-grained PAT with read access to Contents and Pull requests." >&2
  exit 1
fi

echo "==> Checking cluster connectivity"
kubectl cluster-info >/dev/null

echo "==> Installing ingress-nginx"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer \
  --set controller.ingressClassResource.default=true \
  --wait --timeout 10m

echo "==> Installing ArgoCD"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

echo "==> Waiting for ArgoCD to come up"
kubectl wait --for=condition=available --timeout=10m \
  deployment/argocd-server deployment/argocd-applicationset-controller -n argocd

echo "==> Storing the GitHub token for the pull request generator"
kubectl create secret generic github-token \
  --namespace argocd \
  --from-literal=token="$GITHUB_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> Applying ArgoCD manifests for owner=$OWNER node=$NODE_IP"
# The manifests are committed with placeholders so the repo carries no
# account-specific values; they are substituted at apply time.
# GHCR paths must be lowercase even when the GitHub username is not.
OWNER_LC=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')

for manifest in "$REPO_ROOT"/argocd/*.yaml; do
  sed -e "s|__OWNER_LC__|$OWNER_LC|g" \
      -e "s|__OWNER__|$OWNER|g" \
      -e "s|__NODE_IP__|$NODE_IP|g" \
      -e "s|__PROD_IMAGE_TAG__|latest|g" \
      "$manifest" | kubectl apply -f -
done

echo
echo "Done."
echo "  ArgoCD UI:       kubectl port-forward svc/argocd-server -n argocd 8080:443"
echo "  Admin password:  kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
echo "  Preview URLs:    http://pr-<number>.$NODE_IP.nip.io"
echo
echo "Open a pull request to create your first environment."
