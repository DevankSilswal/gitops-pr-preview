#!/usr/bin/env bash
#
# Points a repository's pull request events at this cluster's ArgoCD.
#
#   WEBHOOK_SECRET=... ./scripts/register-webhook.sh <owner/repo> <base-host>
#
# Without this, ArgoCD finds out a pull request changed by asking every few
# minutes. With it, GitHub says so immediately and the environment appears in
# seconds rather than up to an interval later.
#
# It can only be run by someone who administers the repository, which is the
# honest limit of this: the platform can serve a repository it does not own,
# but it cannot install a webhook there. Those repositories keep the poll,
# which is why the poll still exists.

set -euo pipefail

TARGET="${1:-}"
BASE_HOST="${2:-}"

if [[ -z "$TARGET" || -z "$BASE_HOST" ]]; then
  echo "usage: $0 <owner/repo> <base-host>" >&2
  echo "  e.g. $0 DevankSilswal/gitops-pr-preview 20-24-211-179.nip.io" >&2
  exit 1
fi

if [[ -z "${WEBHOOK_SECRET:-}" ]]; then
  echo "WEBHOOK_SECRET is not set." >&2
  echo "It must match what bootstrap-cluster.sh put in argocd-secret, or every" >&2
  echo "delivery is rejected as unsigned — silently, from GitHub's side." >&2
  exit 1
fi

URL="https://argocd-webhook.${BASE_HOST}/api/webhook"

echo "==> Pointing $TARGET at $URL"

# Replace rather than accumulate: running this twice should leave one hook.
EXISTING=$(gh api "repos/$TARGET/hooks" --jq \
  ".[] | select(.config.url == \"$URL\") | .id" 2>/dev/null | head -1)

if [[ -n "$EXISTING" ]]; then
  echo "    updating existing hook $EXISTING"
  gh api -X PATCH "repos/$TARGET/hooks/$EXISTING" \
    -f "config[url]=$URL" \
    -f 'config[content_type]=json' \
    -f "config[secret]=$WEBHOOK_SECRET" \
    -F 'active=true' \
    -f 'events[]=pull_request' >/dev/null
else
  gh api -X POST "repos/$TARGET/hooks" \
    -f 'name=web' \
    -f "config[url]=$URL" \
    -f 'config[content_type]=json' \
    -f "config[secret]=$WEBHOOK_SECRET" \
    -F 'active=true' \
    -f 'events[]=pull_request' >/dev/null
  echo "    created"
fi

echo
echo "Deliveries are visible at:"
echo "  https://github.com/$TARGET/settings/hooks"
echo
echo "A delivery answered with 200 means ArgoCD accepted the signature. A 401"
echo "means WEBHOOK_SECRET here and the one in argocd-secret disagree."
