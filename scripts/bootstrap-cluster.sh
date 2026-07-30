#!/usr/bin/env bash
#
# One-shot cluster setup. Run once against a fresh cluster, with KUBECONFIG
# already pointing at it.
#
#   export GITHUB_TOKEN=github_pat_...
#   ./scripts/bootstrap-cluster.sh <github-owner> <node-public-ip>
#
# Optional:
#   ACME_EMAIL=you@example.com     also install cert-manager and TLS issuers
#   WITH_OBSERVABILITY=1           also install Prometheus and Grafana
#
# Installs the platform, gives ArgoCD a token to read pull requests, then
# applies the ApplicationSet. Nothing here runs again afterwards: opening a
# pull request is the only action needed to create an environment.

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
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null

if [[ -n "${DEV_CLUSTER:-}" ]]; then
  # kind has no load balancer implementation, so the controller binds the
  # node's ports directly. scripts/kind-cluster.yaml maps those to the host,
  # which makes nip.io hostnames resolve exactly as they do in production.
  INGRESS_ARGS=(
    --set controller.hostPort.enabled=true
    --set controller.service.type=NodePort
    # nodeSelector values are strings in the Kubernetes API. Plain --set sends
    # a bare true, which the API server rejects as a type error.
    --set-string controller.nodeSelector."ingress-ready"=true
    --set-string controller.tolerations[0].key=node-role.kubernetes.io/control-plane
    --set-string controller.tolerations[0].operator=Exists
    --set-string controller.tolerations[0].effect=NoSchedule
  )
else
  INGRESS_ARGS=(--set controller.service.type=LoadBalancer)
fi

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  "${INGRESS_ARGS[@]}" \
  --set controller.ingressClassResource.default=true \
  --wait --timeout 10m

if [[ -n "${ACME_EMAIL:-}" ]]; then
  echo "==> Installing cert-manager"
  helm upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager --create-namespace \
    --set crds.enabled=true \
    --wait --timeout 10m

  echo "==> Creating Let's Encrypt issuers"
  sed "s|__ACME_EMAIL__|$ACME_EMAIL|g" \
    "$REPO_ROOT/deploy/platform/cluster-issuers.yaml" | kubectl apply -f -
else
  echo "==> Skipping cert-manager (set ACME_EMAIL to enable TLS)"
fi

if [[ -n "${WITH_OBSERVABILITY:-}" ]]; then
  echo "==> Installing Prometheus and Grafana"
  helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
    --namespace monitoring --create-namespace \
    --values "$REPO_ROOT/deploy/platform/observability/values.yaml" \
    --wait --timeout 15m
  kubectl apply -f "$REPO_ROOT/deploy/platform/observability/dashboard.yaml"
else
  echo "==> Skipping observability (set WITH_OBSERVABILITY=1 to enable)"
fi

echo "==> Installing ArgoCD"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
# Server-side apply is required, not a preference: ArgoCD's CRDs are larger
# than the 262144-byte ceiling on the last-applied-configuration annotation
# that client-side apply writes, so a plain `kubectl apply` fails outright on
# applicationsets.argoproj.io.
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

echo "==> Waiting for ArgoCD to come up"
kubectl wait --for=condition=available --timeout=10m \
  deployment/argocd-server deployment/argocd-applicationset-controller -n argocd

echo "==> Storing the GitHub token for the pull request generator"
kubectl create secret generic github-token \
  --namespace argocd \
  --from-literal=token="$GITHUB_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> Applying ArgoCD manifests for owner=$OWNER node=$NODE_IP"
# GHCR paths must be lowercase even when the GitHub username is not.
OWNER_LC=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')

# nip.io splits on dashes as well as dots when it looks for an address, so a
# dotted IP after a label like `pr-1` is misread: pr-1.127.0.0.1.nip.io
# resolves to 1.127.0.0. Writing the address in dash form removes the
# ambiguity and keeps the readable pr-<number> prefix.
PREVIEW_BASE_HOST="$(echo "$NODE_IP" | tr '.' '-').nip.io"

# The manifests are committed with placeholders so the repo carries no
# account-specific values; they are substituted at apply time.
for manifest in "$REPO_ROOT"/deploy/argocd/*.yaml; do
  sed -e "s|__OWNER_LC__|$OWNER_LC|g" \
      -e "s|__OWNER__|$OWNER|g" \
      -e "s|__PREVIEW_BASE_HOST__|$PREVIEW_BASE_HOST|g" \
      -e "s|__PROD_IMAGE_TAG__|latest|g" \
      "$manifest" | kubectl apply -f -
done

cat <<EOF

Done.
  ArgoCD UI:       kubectl port-forward svc/argocd-server -n argocd 8080:443
  Admin password:  kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
  Preview URLs:    http://pr-<number>.$PREVIEW_BASE_HOST

Set PREVIEW_BASE_HOST to '$PREVIEW_BASE_HOST' in the repository variables so CI
can post preview links on pull requests:
  gh variable set PREVIEW_BASE_HOST --body '$PREVIEW_BASE_HOST'

Label a pull request 'preview' to create your first environment.
EOF
