#!/usr/bin/env bash
#
# The slug is derived in three places, and all three have to agree:
#
#   1. scripts/discover-repos.rb — Ruby. Decides the hostname that exists.
#   2. .github/workflows/preview-build.yml — shell, inline. Decides the
#      hostname the pull request comment advertises.
#   3. scripts/lib/slug.sh — shell, sourced by init-platform.sh so a fresh
#      fork onboards itself under the slug the other two will derive.
#
# When 1 and 2 disagreed, every comment linked to a hostname that had never
# existed — on the one feature this platform is for. 3 was added after
# init-platform.sh was found hardcoding the slug "arcade", which reintroduced
# exactly that bug for anyone who forked.
#
# shell_slug below is a deliberate retyping of the workflow's inline copy —
# that is what makes this a drift test rather than a tautology. Retyping alone
# would not notice someone editing the workflow, so the constants in the
# workflow file are asserted structurally at the end as well.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/slug.sh
. "$REPO_ROOT/scripts/lib/slug.sh"

CASES=(
  "DevankSilswal/gitops-pr-preview"
  "DevankSilswal/notes-board"
  "some.user/My_Cool_App"
  "UPPER/CASE"
  "a/b"
  "-leading/trailing-"
  "org.with.dots/repo_with_underscores"
  "a-very-long-organisation-name-indeed/an-extremely-long-repository-name-here"
  "another-extremely-long-organisation/another-extremely-long-repository-name"
)

ruby_slug() {
  ruby -rdigest -e '
    owner, repo = ARGV[0].split("/", 2)
    base = "#{owner}-#{repo}".downcase.gsub(/[^a-z0-9]+/, "-").gsub(/\A-+|-+\z/, "")
    puts base.length <= 45 ? base : "#{base[0, 38]}-#{Digest::SHA256.hexdigest(base)[0, 6]}"
  ' -- "$1"
}

# Kept character-for-character in step with the workflow. If you change one,
# this fails until you change the other, which is the entire point.
shell_slug() {
  local slug
  # printf, not echo: a value starting with a dash is an option to echo.
  slug=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's#[^a-z0-9]+#-#g; s#^-+|-+$##g')
  if [ ${#slug} -gt 45 ]; then
    local digest
    digest=$(printf '%s' "$slug" | shasum -a 256 | cut -c1-6)
    slug="${slug:0:38}-${digest}"
  fi
  printf '%s' "$slug"
}

failed=0
for case in "${CASES[@]}"; do
  rb=$(ruby_slug "$case")
  sh=$(shell_slug "$case")
  # The copy init-platform.sh uses, so a fork cannot onboard itself under a
  # slug that disagrees with the one CI advertises.
  lib=$(slug_for "$case")

  if [ "$rb" = "$sh" ] && [ "$rb" = "$lib" ]; then
    printf 'ok   %-76s -> %s\n' "$case" "$rb"
  else
    printf 'FAIL %-76s\n     ruby=%s\n     workflow=%s\n     lib=%s\n' "$case" "$rb" "$sh" "$lib"
    failed=1
  fi

  # The whole `<slug>-pr-<number>` has to fit in one DNS label.
  label="${rb}-pr-99999"
  if [ ${#label} -gt 63 ]; then
    printf 'FAIL %s produces a %d-character DNS label\n' "$case" "${#label}"
    failed=1
  fi
done

# The cases above exercise shell_slug, which is a copy. If somebody edits the
# rule in the workflow itself, every case here still passes while the real
# hostnames change. Assert the workflow still contains the rule these cases
# were written against.
WORKFLOW="$REPO_ROOT/.github/workflows/preview-build.yml"
echo
for fragment in \
  's#[^a-z0-9]+#-#g; s#^-+|-+$##g' \
  '${#SLUG} -gt 45' \
  'shasum -a 256 | cut -c1-6' \
  '${SLUG:0:38}-${DIGEST}'
do
  if grep -qF -- "$fragment" "$WORKFLOW"; then
    printf 'ok   workflow still contains: %s\n' "$fragment"
  else
    printf 'FAIL workflow no longer contains: %s\n' "$fragment"
    printf '     the inline derivation changed; update shell_slug here to match\n'
    failed=1
  fi
done

exit "$failed"
