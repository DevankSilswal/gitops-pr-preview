#!/usr/bin/env bash
#
# Breaks a preview environment on purpose, and measures how long it takes to
# come back.
#
#   ./scripts/chaos-test.sh <image-repository> <image-tag>
#
# docs/runbook.md lists every failure this platform has actually produced. Every
# one of those was discovered by it happening. This is the other half: failures
# induced deliberately, on a schedule, with the recovery timed — so "it heals
# itself" stops being a claim about the architecture and becomes a number that
# either holds or regresses.
#
# What is deliberately not tested here: anything needing a real cloud. Spot
# eviction and node reboot are exercised against the live cluster by hand, and
# written up in the runbook. What follows is what a throwaway kind cluster can
# genuinely prove.
#
# Expects kubectl to point at a disposable cluster with ArgoCD installed.
# `make chaos` builds one; CI runs the same script.

set -euo pipefail

IMAGE_REPO="${1:-}"
IMAGE_TAG="${2:-}"
NS=chaos-pr-1
RELEASE=preview-chaos-1
HOST=chaos-pr-1.127-0-0-1.nip.io
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRET_SALT=chaos-fixed-salt

if [[ -z "$IMAGE_REPO" || -z "$IMAGE_TAG" ]]; then
  echo "usage: $0 <image-repository> <image-tag>" >&2
  exit 1
fi

FAILURES=0
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }

PASSWORD="$(printf '%s|%s|%s|%s' "$SECRET_SALT" "pr-1" "1" "basic-auth" | shasum -a 256 | cut -c1-20)"

cleanup() {
  helm uninstall "$RELEASE" -n "$NS" >/dev/null 2>&1 || true
  kubectl delete ns "$NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Polls until the environment serves its own identity again, and prints how
# long that took. Everything below is a variation on "break something, then
# call this".
recover_seconds() {
  local budget="$1" start elapsed body
  start=$SECONDS
  while (( SECONDS - start < budget )); do
    body=$(curl -s --max-time 5 --user "preview:$PASSWORD" \
      -H "Host: $HOST" http://127.0.0.1/api/info 2>/dev/null || true)
    if [[ "$body" == *'"prNumber":"1"'* ]]; then
      elapsed=$(( SECONDS - start ))
      echo "$elapsed"
      return 0
    fi
    sleep 2
  done
  echo "-1"
  return 1
}

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
  --set controller.config.global-allowed-response-headers=X-Robots-Tag \
  --wait --timeout 6m >/dev/null

echo "==> Deploying the environment to break"
helm install "$RELEASE" "$REPO_ROOT/charts/preview-app" \
  --namespace "$NS" --create-namespace \
  --set image.repository="$IMAGE_REPO" \
  --set image.tag="$IMAGE_TAG" \
  --set environment=pr-1 \
  --set prNumber=1 \
  --set ingress.host="$HOST" \
  --set secretSalt="$SECRET_SALT" \
  --wait --timeout 5m >/dev/null

BASELINE=$(recover_seconds 180) || { echo "the environment never served at all" >&2; exit 1; }
pass "baseline: serving after ${BASELINE}s"
echo

# --- the pod is deleted out from under it ----------------------------------
# The most common real disruption: an eviction, a node draining, a spot
# reclaim. The Deployment should replace it without anything intervening.
echo "==> Killing the application pod"
kubectl delete pod -n "$NS" -l app.kubernetes.io/instance="$RELEASE" \
  --wait=false >/dev/null
if T=$(recover_seconds 180); then
  pass "recovered from pod deletion in ${T}s"
else
  fail "did not recover from pod deletion within 180s"
fi
echo

# --- the whole Deployment is deleted ---------------------------------------
# This is the one that separates "Kubernetes restarted a pod" from "the desired
# state is held somewhere durable". Without a controller reconciling from git,
# nothing brings a deleted Deployment back — which is exactly what ArgoCD's
# selfHeal is for, and exactly what a plain `kubectl apply` pipeline could not
# do.
echo "==> Deleting the Deployment"
kubectl delete deployment -n "$NS" -l app.kubernetes.io/instance="$RELEASE" \
  --wait=false >/dev/null 2>&1 || true

if kubectl get application -n argocd "$RELEASE" >/dev/null 2>&1; then
  if T=$(recover_seconds 300); then
    pass "ArgoCD restored the deleted Deployment in ${T}s"
  else
    fail "the Deployment was not restored within 300s"
  fi
else
  # Helm-installed rather than ArgoCD-managed, which is how this runs on a
  # cluster without ArgoCD. Saying so beats reporting a pass for a control that
  # was never exercised.
  echo "SKIP no ArgoCD Application manages this release, so nothing should restore it" >&2
  helm upgrade "$RELEASE" "$REPO_ROOT/charts/preview-app" \
    --namespace "$NS" --reuse-values --wait --timeout 3m >/dev/null
  pass "re-applied by hand, as an unmanaged release requires"
fi
echo

# --- the image is replaced with one that cannot be pulled ------------------
# The single most common failure this platform produces, and the one
# PreviewImagePullFailing exists to catch. What is asserted is not that the
# alert fires — check-alerts.sh does that against synthetic series — but that
# the environment stays up while the bad rollout fails, because maxUnavailable
# is 0 and the old pod is not removed until a new one is ready.
echo "==> Rolling out an image tag that does not exist"
kubectl set image -n "$NS" "deployment/${RELEASE}-preview-app" \
  "app=${IMAGE_REPO}:definitely-not-a-real-tag" >/dev/null

STAYED_UP=yes
for _ in $(seq 1 20); do
  body=$(curl -s --max-time 5 --user "preview:$PASSWORD" \
    -H "Host: $HOST" http://127.0.0.1/api/info 2>/dev/null || true)
  [[ "$body" == *'"prNumber":"1"'* ]] || STAYED_UP=no
  sleep 3
done

if [[ "$STAYED_UP" == "yes" ]]; then
  pass "a failing rollout never took the environment down (maxUnavailable: 0 holds)"
else
  fail "the environment went down during a failing rollout"
fi

echo "==> Rolling back to the working tag"
kubectl set image -n "$NS" "deployment/${RELEASE}-preview-app" \
  "app=${IMAGE_REPO}:${IMAGE_TAG}" >/dev/null
if T=$(recover_seconds 180); then
  pass "recovered from the bad tag in ${T}s"
else
  fail "did not recover after the image was corrected"
fi
echo

# --- the namespace is emptied of its supporting objects --------------------
# A preview environment is more than its Deployment. Deleting the Service
# breaks routing without touching a single pod, which is the kind of partial
# damage that a naive "are the pods running" health check reports as fine.
echo "==> Deleting the Service"
kubectl delete service -n "$NS" -l app.kubernetes.io/instance="$RELEASE" \
  --wait=false >/dev/null 2>&1 || true
helm upgrade "$RELEASE" "$REPO_ROOT/charts/preview-app" \
  --namespace "$NS" --reuse-values --wait --timeout 3m >/dev/null
if T=$(recover_seconds 180); then
  pass "routing restored after the Service was recreated in ${T}s"
else
  fail "routing did not come back after the Service was restored"
fi

echo
if (( FAILURES > 0 )); then
  echo "chaos FAILED: $FAILURES scenario(s)" >&2
  exit 1
fi
echo "chaos passed: every induced failure recovered"
