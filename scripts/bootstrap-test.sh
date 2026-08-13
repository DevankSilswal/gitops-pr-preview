#!/usr/bin/env bash
#
# Runs bootstrap-cluster.sh against a throwaway cluster, twice.
#
#   ./scripts/bootstrap-test.sh
#
# The recovery story for this platform is "destroy the VM and run the bootstrap
# script". That is a real and demonstrated property — but it was demonstrated by
# the person who wrote the script, on a good day, by hand. Nothing checked it
# afterwards, which means the recovery path was exactly as reliable as one
# person's memory: a 250-line script whose failure mode is discovered during an
# outage, by whoever is left.
#
# So this asserts the two things the recovery story actually depends on:
#
#   1. It works from nothing. A fresh cluster ends up with ArgoCD, the project,
#      the ApplicationSet and the production Application all present.
#   2. It is safe to run again. This is the property that matters most during an
#      incident, because the honest response to "did that work?" is to run it
#      again — and a script that is only correct the first time punishes exactly
#      that instinct. A second run must change nothing and break nothing.
#
# Runs without GITHUB_TOKEN having any real access: nothing here talks to the
# GitHub API, only stores the token as a secret for the generator to use later.
#
# Expects kubectl to point at a disposable cluster. `make bootstrap-test`
# creates one with kind; CI does the same.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FAILURES=0
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }

# DEV_CLUSTER makes the ingress controller bind host ports rather than wait for
# a load balancer that kind cannot provide.
export DEV_CLUSTER=1
export GITHUB_TOKEN=not-a-real-token-nothing-here-calls-github
export WEBHOOK_SECRET=bootstrap-test-secret

echo "############ first run ############"
if ! "$REPO_ROOT/scripts/bootstrap-cluster.sh" 127.0.0.1; then
  echo "the first run failed outright" >&2
  exit 1
fi
pass "bootstrap completes against a fresh cluster"

# --- what should exist afterwards -----------------------------------------
expect_exists() {
  local kind="$1" name="$2" ns="${3:-argocd}"
  if kubectl -n "$ns" get "$kind" "$name" >/dev/null 2>&1; then
    pass "$kind/$name exists"
  else
    fail "$kind/$name is missing after bootstrap"
  fi
}

expect_exists deployment argocd-server
expect_exists deployment argocd-applicationset-controller
expect_exists appproject previews
expect_exists applicationset preview-environments
expect_exists application preview-app-prod
expect_exists secret github-token
expect_exists secret preview-secret-salt
expect_exists ingress argocd-webhook

# The salt is what every per-environment password is derived from. Capturing it
# is how the second run gets checked for the thing that would be worst to get
# wrong.
SALT_BEFORE=$(kubectl -n argocd get secret preview-secret-salt -o jsonpath='{.data.salt}')
APPSET_BEFORE=$(kubectl -n argocd get applicationset preview-environments -o jsonpath='{.spec}' | shasum -a 256 | cut -c1-16)

echo
echo "############ second run ############"
if ! "$REPO_ROOT/scripts/bootstrap-cluster.sh" 127.0.0.1; then
  fail "the second run failed; re-running the bootstrap is not safe"
  echo "FAILED" >&2
  exit 1
fi
pass "bootstrap completes a second time"

# --- and changed nothing ---------------------------------------------------
SALT_AFTER=$(kubectl -n argocd get secret preview-secret-salt -o jsonpath='{.data.salt}')
APPSET_AFTER=$(kubectl -n argocd get applicationset preview-environments -o jsonpath='{.spec}' | shasum -a 256 | cut -c1-16)

# The one that would hurt. A regenerated salt silently invalidates every preview
# password already posted on an open pull request — no error, no failed sync,
# just reviewers being handed credentials that do not work.
if [[ "$SALT_BEFORE" == "$SALT_AFTER" ]]; then
  pass "the secret salt survived the second run"
else
  fail "the secret salt was regenerated; every password already posted is now wrong"
fi

if [[ "$APPSET_BEFORE" == "$APPSET_AFTER" ]]; then
  pass "the ApplicationSet is unchanged"
else
  fail "the ApplicationSet spec changed between two identical runs"
fi

# Nothing should be crash-looping afterwards. A component that comes up, gets
# reconfigured by the second run and then falls over is exactly the failure this
# test exists to find before an incident does.
BROKEN=$(kubectl get pods -A --no-headers 2>/dev/null \
  | awk '$4 ~ /CrashLoopBackOff|Error|ImagePullBackOff/ { print $1"/"$2 }' || true)
if [[ -z "$BROKEN" ]]; then
  pass "no pod is crash-looping after two runs"
else
  fail "pods are unhealthy after the second run: $BROKEN"
fi

echo
if (( FAILURES > 0 )); then
  echo "bootstrap-test FAILED: $FAILURES assertion(s)" >&2
  exit 1
fi
echo "bootstrap-test passed: it works from nothing, and running it again is safe"
