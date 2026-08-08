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
NS=arcade-pr-1
RELEASE=preview-arcade-1
HOST=arcade-pr-1.127-0-0-1.nip.io
NEIGHBOUR_NS=e2e-neighbour
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A fixed salt, so the password this test expects is the password the chart
# derives. In a real cluster this comes from bootstrap-cluster.sh.
SECRET_SALT=e2e-fixed-salt
# Must match preview-app.derivedSecret in the chart: sha256 of
# salt|environment|prNumber|purpose, first 20 hex characters.
derive() {
  printf '%s|%s|%s|%s' "$SECRET_SALT" "pr-1" "1" "$1" | shasum -a 256 | cut -c1-20
}
PREVIEW_PASSWORD="$(derive basic-auth)"

if [[ -z "$IMAGE_REPO" || -z "$IMAGE_TAG" ]]; then
  echo "usage: $0 <image-repository> <image-tag>" >&2
  exit 1
fi

# Two kinds of failure. `fatal` is for the setup steps every later assertion
# depends on — carrying on past a pod that never started would produce a page
# of confusing errors about one problem. `fail` is for the independent
# assertions, which are each worth knowing about in the same run: finding out
# that isolation is broken, and then on the next run that quotas are too, wastes
# a cluster boot per fact.
FAILURES=0
fatal() { echo "FAIL: $*" >&2; exit 1; }
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }
skip() { echo "SKIP $*" >&2; }

cleanup() {
  helm uninstall "$RELEASE" -n "$NS" >/dev/null 2>&1 || true
  kubectl delete ns "$NS" "$NEIGHBOUR_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
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
  --set controller.config.global-allowed-response-headers=X-Robots-Tag \
  --wait --timeout 6m >/dev/null

echo "==> Deploying a preview environment"
helm install "$RELEASE" "$REPO_ROOT/charts/preview-app" \
  --namespace "$NS" --create-namespace \
  --set image.repository="$IMAGE_REPO" \
  --set image.tag="$IMAGE_TAG" \
  --set environment=pr-1 \
  --set prNumber=1 \
  --set ingress.host="$HOST" \
  --set secretSalt="$SECRET_SALT" \
  --wait --timeout 5m >/dev/null

# --- the pod actually runs -------------------------------------------------
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/instance="$RELEASE" \
  -n "$NS" --timeout=180s >/dev/null || fatal "pod never became ready"
pass "pod passes its readiness probe"

# --- the security context is enforced, not merely declared -----------------
POD=$(kubectl get pod -n "$NS" -l app.kubernetes.io/instance="$RELEASE" -o name | head -1)

UID_IN_POD=$(kubectl exec -n "$NS" "$POD" -- id -u 2>/dev/null | tr -d '\r')
if [[ "$UID_IN_POD" == "10001" ]]; then
  pass "container runs as uid 10001"
else
  fail "expected uid 10001 inside the pod, got '$UID_IN_POD'"
fi

if kubectl exec -n "$NS" "$POD" -- sh -c 'touch /probe-write' >/dev/null 2>&1; then
  fail "root filesystem is writable; readOnlyRootFilesystem is not in effect"
else
  pass "root filesystem is read-only"
fi

# --- isolation and limits, tested by behaviour rather than by presence -----
#
# These used to be `kubectl get networkpolicy | grep -q .` — which an empty
# policy passes, and a policy that denies nothing passes just as well. The
# README claimed environments were isolated, the metadata service unreachable
# and quotas enforced, and all three had been checked once by hand and never
# again. What follows is those same claims, made to hold on every run.

# Whether NetworkPolicy is enforced at all is a property of the CNI, not of the
# chart. Some clusters — kind's default among them, historically — accept
# policy objects and route traffic as if they were not there. Asserting
# isolation on such a cluster produces a failure that says the chart is broken
# when the chart is fine, and skipping silently would be worse: it would look
# like the control had been verified. So the enforcement is measured first, and
# the result of that measurement decides whether the assertions run.
echo "==> Checking whether this cluster enforces NetworkPolicy"
kubectl create namespace "$NEIGHBOUR_NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl run neighbour -n "$NEIGHBOUR_NS" --image=busybox:1.36 --restart=Never \
  --command -- sleep 900 >/dev/null
kubectl wait --for=condition=Ready pod/neighbour -n "$NEIGHBOUR_NS" --timeout=120s >/dev/null \
  || fatal "the neighbouring probe pod never started"

# The control: a namespace with no policy at all must be reachable. If even
# this fails, the cluster is broken in some way that has nothing to do with
# what is being tested.
CONTROL_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.spec.clusterIP}')
if kubectl exec -n "$NEIGHBOUR_NS" neighbour -- \
     timeout 5 nc -z "$CONTROL_IP" 80 >/dev/null 2>&1; then
  NETPOL_TESTABLE=yes
else
  NETPOL_TESTABLE=no
fi

SVC_IP=$(kubectl get svc -n "$NS" -l app.kubernetes.io/instance="$RELEASE" \
  -o jsonpath='{.items[0].spec.clusterIP}')

if [[ "$NETPOL_TESTABLE" == "no" ]]; then
  skip "cannot test isolation: the probe pod could not reach an unrestricted service either"
else
  # The real assertion. A pod in another namespace must not reach this
  # environment's Service — not slowly, not at all.
  if kubectl exec -n "$NEIGHBOUR_NS" neighbour -- \
       timeout 5 nc -z "$SVC_IP" 80 >/dev/null 2>&1; then
    # Distinguish "the policy does not work" from "this CNI ignores policies",
    # because they call for completely different fixes.
    if kubectl get networkpolicy -n "$NS" -o name | grep -q .; then
      skip "another namespace reached this environment; the CNI appears not to enforce NetworkPolicy (kindnet does not, by default)"
    else
      fail "no NetworkPolicy exists and another namespace reached this environment"
    fi
  else
    pass "a pod in another namespace cannot reach this environment"
  fi
fi

# Egress. The link-local metadata service hands out instance credentials to
# anything on the node that asks, so a single SSRF in a pull request would be
# enough without this. Tested from inside the environment, against the real
# address.
if kubectl exec -n "$NS" "$POD" -- \
     timeout 5 wget -q -O- http://169.254.169.254/ >/dev/null 2>&1; then
  fail "the cloud metadata service is reachable from inside a preview environment"
else
  pass "cloud metadata (169.254.169.254) is unreachable from the environment"
fi

# The quota has to refuse things, not merely exist. Asking for more memory than
# the LimitRange permits per container is the cheapest way to prove it: the API
# server rejects the object outright, so nothing has to be scheduled or waited
# for.
if kubectl -n "$NS" run quota-probe --image=busybox:1.36 --restart=Never \
     --overrides='{"spec":{"containers":[{"name":"quota-probe","image":"busybox:1.36","command":["sleep","30"],"resources":{"requests":{"memory":"8Gi","cpu":"4"},"limits":{"memory":"8Gi","cpu":"4"}}}]}}' \
     >/dev/null 2>&1; then
  kubectl -n "$NS" delete pod quota-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fail "an oversized pod was admitted; the ResourceQuota and LimitRange are decorative"
else
  pass "an oversized pod is refused, not queued"
fi

# Pod Security Admission, likewise. The chart already asks for a locked-down
# security context, but a chart is only a request — this is the API server
# refusing anything that stops meeting the baseline, including whatever a pull
# request might add to its own namespace later.
if kubectl -n "$NS" run pss-probe --image=busybox:1.36 --restart=Never \
     --overrides='{"spec":{"containers":[{"name":"pss-probe","image":"busybox:1.36","command":["sleep","30"],"securityContext":{"privileged":true}}]}}' \
     >/dev/null 2>&1; then
  kubectl -n "$NS" delete pod pss-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fail "a privileged pod was admitted; restricted Pod Security Admission is not enforced"
else
  pass "a privileged pod is rejected by Pod Security Admission"
fi

# --- traffic reaches it through the ingress, routed by Host ---------------
# Wait for the expected body, not merely for a body. ingress-nginx answers
# immediately with its own 404 page while the rule is still being programmed,
# so a non-empty response proves nothing and made this test flaky: it passed
# locally, where the controller was already warm, and failed in CI.
BODY=""
for _ in $(seq 1 40); do
  BODY=$(curl -s --max-time 5 --user "preview:$PREVIEW_PASSWORD" \
    -H "Host: $HOST" http://127.0.0.1/api/info 2>/dev/null || true)
  [[ "$BODY" == *'"prNumber":"1"'* ]] && break
  sleep 5
done

[[ "$BODY" == *'"prNumber":"1"'* ]] || fatal "ingress never served this environment for Host: $HOST (last response: ${BODY:-<empty>})"
if [[ "$BODY" == *'"environment":"pr-1"'* ]]; then
  pass "ingress routes by Host and the app reports its own identity"
else
  fail "wrong environment name: $BODY"
fi

# An unknown host must not fall through to this environment.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -H "Host: other-pr-999.127-0-0-1.nip.io" http://127.0.0.1/api/info 2>/dev/null || echo 000)
if [[ "$CODE" != "200" ]]; then
  pass "unrelated hostnames do not reach it (got $CODE)"
else
  fail "an unrelated hostname reached this environment"
fi

# --- the environment is private, and says so ------------------------------
# An auth annotation that silently fails open looks exactly like one that
# works, and the difference is whether unreleased work is on the open internet.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -H "Host: $HOST" http://127.0.0.1/api/info 2>/dev/null || echo 000)
if [[ "$CODE" == "401" ]]; then
  pass "requests without the preview password are refused"
else
  fail "a request with no credentials got $CODE, expected 401"
fi

# The password the chart derived has to be the one CI would post. If these ever
# drift, every reviewer gets a password that does not work — the same class of
# bug as the slug mismatch, in the one place nobody would think to check.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  --user "preview:$PREVIEW_PASSWORD" -H "Host: $HOST" http://127.0.0.1/ 2>/dev/null || echo 000)
if [[ "$CODE" == "200" ]]; then
  pass "the password derived exactly as CI derives it is accepted"
else
  fail "the derived preview password was rejected (got $CODE)"
fi

ROBOTS=$(curl -s -D- -o /dev/null --max-time 5 --user "preview:$PREVIEW_PASSWORD" \
  -H "Host: $HOST" http://127.0.0.1/ 2>/dev/null | tr -d '\r' \
  | sed -nE 's/^[Xx]-[Rr]obots-[Tt]ag: (.*)$/\1/p')
if [[ "$ROBOTS" == *noindex* ]]; then
  pass "responses carry X-Robots-Tag: noindex"
else
  fail "no X-Robots-Tag: noindex header (got '${ROBOTS:-none}')"
fi

# --- and it all goes away again -------------------------------------------
helm uninstall "$RELEASE" -n "$NS" >/dev/null
for _ in $(seq 1 30); do
  kubectl get pod -n "$NS" -l app.kubernetes.io/instance="$RELEASE" 2>/dev/null | grep -q . || break
  sleep 4
done
if kubectl get pod -n "$NS" -l app.kubernetes.io/instance="$RELEASE" 2>/dev/null | grep -q .; then
  fail "workloads survived the release being removed"
else
  pass "removing the release removes the workloads"
fi

echo
if [[ "$FAILURES" -gt 0 ]]; then
  echo "e2e FAILED: $FAILURES assertion(s)" >&2
  exit 1
fi
echo "e2e passed"
