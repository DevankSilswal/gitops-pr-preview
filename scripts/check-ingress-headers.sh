#!/usr/bin/env bash
# Refuse a chart that asks the ingress controller for a header the controller
# has not been told to allow.
#
# This is the regression guard for the outage of 2026-08-13. The preview chart
# gained a `custom-headers` annotation naming X-Robots-Tag; the live controller's
# allow-list was empty; ingress-nginx does not ignore such an annotation — it
# denies the whole location, so every request to the host returned 503 while the
# pods stayed perfectly healthy.
#
# What makes this guard worth having is that nothing else could have caught it.
# The e2e suite runs against a kind cluster whose controller is installed by
# scripts/e2e-test.sh, which carried its own copy of the allow-list flag, so the
# header was always permitted there. Two literals that agree by luck are not a
# test; they are the same assumption written twice.
#
# Three assertions:
#   1. every header the chart asks for appears in the allow-list
#   2. neither install site sets the allow-list inline, which would let the two
#      drift apart again
#   3. the allow-list is non-empty, so a truncated file fails loudly rather than
#      permitting nothing and looking like a chart with no headers
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES="$REPO_ROOT/deploy/platform/ingress-nginx-values.yaml"
CHART="$REPO_ROOT/charts/preview-app"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

[[ -f "$VALUES" ]] || fail "missing $VALUES — the allow-list has no source of truth"

# --- 1. what the controller is permitted to emit ---------------------------
ALLOWED=$(
  awk '/global-allowed-response-headers:/ { sub(/.*global-allowed-response-headers:[[:space:]]*/, ""); print; exit }' \
    "$VALUES" | tr -d '"'"'"' \r'
)
[[ -n "$ALLOWED" ]] || fail "global-allowed-response-headers is empty or absent in $VALUES"
pass "allow-list from $(basename "$VALUES"): $ALLOWED"

# --- 2. what the chart asks for --------------------------------------------
# Rendered with every header-emitting feature switched on, because the failure
# only exists in the combination that reaches a cluster. Rendering the default
# would prove nothing the day the default changes.
RENDERED=$(
  helm template guard "$CHART" \
    --set ingress.host=guard-pr-1.127-0-0-1.nip.io \
    --set auth.noIndex=true
)

# Header names are the data keys of the ConfigMap the annotation points at.
# They are indented under `data:`, so the scan tracks which document it is in
# rather than matching key-shaped lines anywhere in the render — the labels
# block above `data:` is also key-shaped, and so is half of the Ingress.
REQUESTED=$(
  printf '%s\n' "$RENDERED" | awk '
    /^---/                             { inmap = 0; indata = 0; next }
    /^kind: ConfigMap$/                { inmap = 1; indata = 0; next }
    /^kind: /                          { inmap = 0; indata = 0; next }
    inmap && /^data:[[:space:]]*$/     { indata = 1; next }
    indata && /^  [A-Za-z0-9-]+:/      { key = $0; sub(/^  /, "", key); sub(/:.*/, "", key); print key; next }
    indata && /^[^[:space:]]/          { indata = 0 }
  ' | sort -u
)

if [[ -z "$REQUESTED" ]]; then
  fail "the chart rendered no response headers with auth.noIndex=true — either the
      feature was removed and this guard is now lying, or the renderer changed
      shape. Both need a human."
fi

# --- 3. every requested header must be allowed ------------------------------
MISSING=""
while read -r header; do
  [[ -z "$header" ]] && continue
  if printf '%s' "$ALLOWED" | tr ',' '\n' | tr -d ' ' | grep -qxF "$header"; then
    pass "chart asks for '$header' and the controller allows it"
  else
    MISSING="$MISSING $header"
  fi
done <<< "$REQUESTED"

if [[ -n "$MISSING" ]]; then
  fail "the chart asks the ingress controller to emit:$MISSING
      but $VALUES does not allow it.

      ingress-nginx will not ignore this. It denies the entire location, and
      every request to every host served by that Ingress returns 503 — with the
      pods reporting healthy the whole time. This is exactly what took
      production down on 2026-08-13.

      Fix by adding the header to global-allowed-response-headers in
      $(basename "$VALUES"), or by not asking for it in the chart."
fi

# --- 4. neither install site may set the allow-list inline ------------------
# The outage was possible because the setting existed as two literals that
# nothing compared. Inline --set is how that comes back.
for script in scripts/bootstrap-cluster.sh scripts/e2e-test.sh; do
  if grep -qE '(--set|--set-string)[[:space:]=]*controller\.config\.global-allowed-response-headers' "$REPO_ROOT/$script"; then
    fail "$script sets global-allowed-response-headers inline.
      It must read $(basename "$VALUES") with 'helm -f' instead, or production
      and the test cluster can drift apart again without either one noticing."
  fi
  if ! grep -q "ingress-nginx-values.yaml" "$REPO_ROOT/$script"; then
    fail "$script installs ingress-nginx without $(basename "$VALUES").
      The kind cluster CI tests against must consume the same controller
      configuration production does, or the e2e suite proves nothing about the
      configuration production actually runs."
  fi
  pass "$script reads the shared controller configuration"
done

echo "ingress header configuration is consistent"
