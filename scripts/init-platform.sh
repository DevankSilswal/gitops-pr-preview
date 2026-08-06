#!/usr/bin/env bash
#
# Point a fresh fork at itself.
#
#   ./scripts/init-platform.sh [owner/repo]
#
# A fork carries the original author's details in a handful of places, and the
# consequential one is quiet: platform.yaml decides where ArgoCD fetches the
# chart. Leave it and your cluster keeps pulling charts from somebody else's
# repository, which works right up until they change it.
#
# This rewrites those references, replaces the example onboarding with one for
# your own repository, and removes the original author's production
# application. Run it once, read the diff, commit it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  # Works for both git@github.com:owner/repo.git and https://github.com/owner/repo.git
  origin="$(git remote get-url origin 2>/dev/null || true)"
  [[ -n "$origin" ]] || { echo "no git remote and no owner/repo given" >&2; exit 1; }
  TARGET="$(echo "$origin" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
fi

if [[ ! "$TARGET" =~ ^[^/]+/[^/]+$ ]]; then
  echo "expected owner/repo, got '$TARGET'" >&2
  exit 1
fi

OWNER="${TARGET%%/*}"
REPO="${TARGET##*/}"
OWNER_LC="$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')"

echo "Pointing this fork at $OWNER/$REPO"

# 1. Where ArgoCD fetches the chart. The one that silently keeps working while
#    being wrong.
cat > deploy/platform/platform.yaml <<EOF
# Cluster-level settings. Which repositories are served lives in onboarded/,
# one file each; this is the handful of things true of the platform itself.

# Where the chart comes from — this repository, not the repository under
# review. An adopter therefore vendors nothing, and a pull request cannot
# change how it is deployed, only what is deployed.
chartRepo: https://github.com/$OWNER/$REPO.git
chartRevision: main
chartPath: charts/preview-app
EOF

# 2. The example onboardings belong to whoever you forked from. Replace them
#    with one for this repository's own sample application.
rm -f deploy/platform/onboarded/*.yaml
cat > deploy/platform/onboarded/arcade.yaml <<EOF
# One file per onboarded repository. ArgoCD reads this directory from git, so
# adding a file here is the whole of onboarding — nothing is run against the
# cluster. Deleting it removes every environment that repository had.
slug: arcade
owner: $OWNER
repo: $REPO
image: ghcr.io/$OWNER_LC/preview-app
port: "3000"
healthPath: /api/health
EOF

# 3. The production Application deploys the sample app from the original
#    author's registry. Keeping it would leave a permanently failing
#    Application in your cluster.
if [[ -f deploy/argocd/application-prod.yaml ]]; then
  sed -i.bak \
    -e "s#repoURL: https://github.com/[^/]*/[^/]*\.git#repoURL: https://github.com/$OWNER/$REPO.git#" \
    -e "s#value: ghcr\.io/[^/]*/preview-app#value: ghcr.io/$OWNER_LC/preview-app#" \
    deploy/argocd/application-prod.yaml
  rm -f deploy/argocd/application-prod.yaml.bak
fi

# 4. Defaults that are only ever overridden, but wrong defaults mislead anyone
#    reading them to understand the chart.
sed -i.bak "s#repository: ghcr\.io/[^/]*/preview-app#repository: ghcr.io/$OWNER_LC/preview-app#" \
  charts/preview-app/values.yaml && rm -f charts/preview-app/values.yaml.bak

sed -i.bak "s#ghcr\.io/[^/]*/preview-app#ghcr.io/$OWNER_LC/preview-app#" Makefile \
  && rm -f Makefile.bak

# 5. The image tag pinned for production came from the other repository's CI
#    and does not exist in yours. CI rewrites this on the first push to main.
sed -i.bak "s#^  tag: .*#  tag: main-replaced-on-first-release#" \
  charts/preview-app/values-production.yaml && rm -f charts/preview-app/values-production.yaml.bak

echo
echo "Rewritten. Check the diff, then:"
echo
echo "  git commit -am 'chore: point the platform at $OWNER/$REPO'"
echo "  git push"
echo
echo "Then set PREVIEW_BASE_HOST in your repository variables once you have a"
echo "cluster address, and run scripts/bootstrap-cluster.sh against it."
echo
echo "Anything referring to the original author now is documentation, which is"
echo "yours to rewrite or leave."
