#!/usr/bin/env bash
# Turn the control plane on, once the GitHub App genuinely exists.
#
#   APP_ID=123456 \
#   WEBHOOK_SECRET=<the secret pasted into the App> \
#   PRIVATE_KEY=~/Downloads/stackpreview.private-key.pem \
#   ./scripts/enable-control-plane.sh
#
# The order matters and is the whole point: this proves the credentials work
# against GitHub *before* anything is deployed. Twice now the platform has been
# told the App was ready when the cluster had no Secret at all, and both times
# the only thing that would have caught it early is a check that actually calls
# GitHub with the key.
#
# It creates the namespace and the Secret. It deliberately does NOT flip
# controlPlane.enabled — that is a commit, because the cluster is reconciled
# from git and a kubectl apply here would be a second source of truth for the
# thing ADR 0003 exists to keep in one place.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE=stackpreview
SECRET=stackpreview-github-app

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "  ok: $*"; }

: "${APP_ID:?APP_ID is not set — the numeric App ID from the App settings page}"
: "${WEBHOOK_SECRET:?WEBHOOK_SECRET is not set — the value pasted into the App webhook secret field}"
: "${PRIVATE_KEY:?PRIVATE_KEY is not set — path to the .pem downloaded when the key was generated}"

# --- 1. the values are the shape they claim to be -------------------------
[[ "$APP_ID" =~ ^[0-9]+$ ]] || fail "APP_ID must be numeric, got '$APP_ID' — that is the App *slug*, not its ID"
[[ -r "$PRIVATE_KEY" ]] || fail "cannot read $PRIVATE_KEY"
openssl rsa -in "$PRIVATE_KEY" -noout 2>/dev/null \
  || fail "$PRIVATE_KEY is not an RSA private key openssl can parse"
(( ${#WEBHOOK_SECRET} >= 16 )) \
  || fail "WEBHOOK_SECRET is ${#WEBHOOK_SECRET} characters; this is the only authentication the webhook endpoint has"
ok "app id is numeric, the key parses, the webhook secret is ${#WEBHOOK_SECRET} characters"

# --- 2. the key and the App ID actually belong together -------------------
# A ten-minute JWT signed with the key, exchanged for the identity of the App.
# If this answers, the credentials are real; nothing else proves that.
b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64)
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$APP_ID" | b64)
signature=$(printf '%s.%s' "$header" "$payload" \
  | openssl dgst -sha256 -sign "$PRIVATE_KEY" -binary | b64)
jwt="${header}.${payload}.${signature}"

app=$(curl -sS -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' \
  https://api.github.com/app) || fail "could not reach api.github.com"

if ! slug=$(printf '%s' "$app" | python3 -c 'import sys,json; print(json.load(sys.stdin)["slug"])' 2>/dev/null); then
  fail "GitHub refused these credentials:
      $(printf '%s' "$app" | head -c 200)
      Either APP_ID belongs to a different App than PRIVATE_KEY, or the key was revoked."
fi
ok "GitHub accepted the key: App $slug, id $APP_ID"

# --- 3. it is installed somewhere, on repositories this platform serves ----
installs=$(curl -sS -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' \
  https://api.github.com/app/installations)
count=$(printf '%s' "$installs" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
(( count > 0 )) || fail "the App exists but is installed nowhere.
      Install it on the repositories in deploy/platform/onboarded/ — an App with
      no installation can mint no token and will never receive an event."
ok "installed on $count account(s)"

onboarded=$(ls "$REPO_ROOT/deploy/platform/onboarded"/*.yaml | wc -l | tr -d ' ')
echo "  note: $onboarded repositories are onboarded; the App must be installed on each"

# --- 4. only now, put it in the cluster -----------------------------------
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create secret generic "$SECRET" --namespace "$NAMESPACE" \
  --from-literal=app-id="$APP_ID" \
  --from-literal=webhook-secret="$WEBHOOK_SECRET" \
  --from-file=private-key.pem="$PRIVATE_KEY" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
ok "secret $NAMESPACE/$SECRET created — its values are not printed and are not in git"

cat <<NEXT

Credentials verified against GitHub and stored. The cluster still runs nothing:
enabling the workload is a commit, because ArgoCD reconciles from git.

  1. set controlPlane.enabled: true in deploy/platform-chart/values.yaml
  2. commit, open a pull request, merge it
  3. watch it arrive:  kubectl get pods -n $NAMESPACE -w
  4. only then, separately, set controlPlane.ingress.enabled: true —
     that one puts an endpoint that can create environments on the internet
NEXT
