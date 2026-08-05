#!/usr/bin/env bash
#
# End-to-end test of a preview environment against a real cluster.
#
#   ./scripts/e2e-test.sh <image-repository> <image-tag>
#
# Everything this asserts was, at some point, broken in a way that rendering
# templates could not have caught: probes that never pass, an ingress that
# routes nowhere, a security context the kubelet rejects, a namespace that
# survives its release. Those are cluster behaviours, so the test needs a
# cluster.
#
# Expects kubectl to already point at a throwaway cluster. `make e2e` creates
# one with kind; CI does the same.

set -euo pipefail

IMAGE_REPO="${1:-}"
IMAGE_TAG="${2:-}"
NS=e2e-pr
RELEASE=e2e-pr-1
HOST=pr-1.127-0-0-1.nip.io
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$IMAGE_REPO" || -z "$IMAGE_TAG" ]]; then
  echo "usage: $0 <image-repository> <image-tag>" >&2
  exit 1
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }

cleanup() {
  helm uninstall "$RELEASE" -n "$NS" >/dev/null 2>&1 || true
  kubectl delete ns "$NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Installing ingress-nginx"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.hostPort.enabled=true \
  --set controller.service.type=NodePort \
  --set-string controller.nodeSelector."ingress-ready"=true \
  --set-string controller.tolerations[0].key=node-role.kubernetes.io/control-plane \
  --set-string controller.tolerations[0].operator=Exists \
  --set-string controller.tolerations[0].effect=NoSchedule \
  --set controller.ingressClassResource.default=true \
  --wait --timeout 6m >/dev/null

echo "==> Deploying a preview environment"
helm install "$RELEASE" "$REPO_ROOT/charts/preview-app" \
  --namespace "$NS" --create-namespace \
  --set image.repository="$IMAGE_REPO" \
  --set image.tag="$IMAGE_TAG" \
  --set environment=pr-1 \
  --set prNumber=1 \
  --set ingress.host="$HOST" \
  --wait --timeout 5m >/dev/null

# --- the pod actually runs -------------------------------------------------
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/instance="$RELEASE" \
  -n "$NS" --timeout=180s >/dev/null || fail "pod never became ready"
pass "pod passes its readiness probe"

# --- the security context is enforced, not merely declared -----------------
POD=$(kubectl get pod -n "$NS" -l app.kubernetes.io/instance="$RELEASE" -o name | head -1)

UID_IN_POD=$(kubectl exec -n "$NS" "$POD" -- id -u 2>/dev/null | tr -d '\r')
[[ "$UID_IN_POD" == "10001" ]] || fail "expected uid 10001 inside the pod, got '$UID_IN_POD'"
pass "container runs as uid 10001"

if kubectl exec -n "$NS" "$POD" -- sh -c 'touch /probe-write' >/dev/null 2>&1; then
  fail "root filesystem is writable; readOnlyRootFilesystem is not in effect"
fi
pass "root filesystem is read-only"

# --- isolation and limits exist -------------------------------------------
kubectl get networkpolicy -n "$NS" -o name | grep -q . || fail "no NetworkPolicy in the namespace"
pass "NetworkPolicy present"

kubectl get resourcequota -n "$NS" -o name | grep -q . || fail "no ResourceQuota in the namespace"
pass "ResourceQuota present"

# --- traffic reaches it through the ingress, routed by Host ---------------
# Wait for the expected body, not merely for a body. ingress-nginx answers
# immediately with its own 404 page while the rule is still being programmed,
# so a non-empty response proves nothing and made this test flaky: it passed
# locally, where the controller was already warm, and failed in CI.
BODY=""
for _ in $(seq 1 40); do
  BODY=$(curl -s --max-time 5 -H "Host: $HOST" http://127.0.0.1/api/info 2>/dev/null || true)
  [[ "$BODY" == *'"prNumber":"1"'* ]] && break
  sleep 5
done

[[ "$BODY" == *'"prNumber":"1"'* ]] || fail "ingress never served this environment for Host: $HOST (last response: ${BODY:-<empty>})"
[[ "$BODY" == *'"environment":"pr-1"'* ]] || fail "wrong environment name: $BODY"
pass "ingress routes by Host and the app reports its own identity"

# An unknown host must not fall through to this environment.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -H "Host: pr-999.127-0-0-1.nip.io" http://127.0.0.1/api/info 2>/dev/null || echo 000)
[[ "$CODE" != "200" ]] || fail "an unrelated hostname reached this environment"
pass "unrelated hostnames do not reach it (got $CODE)"

# --- and it all goes away again -------------------------------------------
helm uninstall "$RELEASE" -n "$NS" >/dev/null
for _ in $(seq 1 30); do
  kubectl get pod -n "$NS" -l app.kubernetes.io/instance="$RELEASE" 2>/dev/null | grep -q . || break
  sleep 4
done
kubectl get pod -n "$NS" -l app.kubernetes.io/instance="$RELEASE" 2>/dev/null | grep -q . \
  && fail "workloads survived the release being removed"
pass "removing the release removes the workloads"

echo
echo "e2e passed"
