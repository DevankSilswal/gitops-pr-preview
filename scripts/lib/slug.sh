#!/usr/bin/env bash
#
# The slug derivation, in shell, in one place.
#
# A slug lands in namespace names and hostnames, and it is derived from owner
# and repository rather than chosen — see scripts/discover-repos.rb for why
# (uniqueness by construction, and nothing squattable when onboarding is open
# to anyone).
#
# There are three copies of this rule in the repository and there have to be:
#
#   1. scripts/discover-repos.rb  — Ruby, decides the hostname that exists
#   2. .github/workflows/preview-build.yml — shell, inline, decides the
#      hostname the pull request comment advertises. It cannot source this
#      file: adopters call that workflow from their own repository, where
#      actions/checkout has checked out *their* code, not the platform's.
#   3. this file — sourced by init-platform.sh, so a fresh fork onboards
#      itself under the same slug the other two will derive
#
# When 1 and 2 disagreed, every preview comment linked to a hostname that had
# never existed. scripts/check-slug-agreement.sh compares all three.

# Derives the slug for a repository given "owner/repo".
slug_for() {
  local input="$1" slug digest

  # printf, not echo: a value starting with a dash is an option to echo.
  slug=$(printf '%s' "$input" | tr '[:upper:]' '[:lower:]' | sed -E 's#[^a-z0-9]+#-#g; s#^-+|-+$##g')

  # Truncated because the whole `<slug>-pr-<number>` has to fit in a
  # 63-character DNS label; the digest keeps truncated names from colliding.
  if [ ${#slug} -gt 45 ]; then
    digest=$(printf '%s' "$slug" | shasum -a 256 | cut -c1-6)
    slug="${slug:0:38}-${digest}"
  fi

  printf '%s' "$slug"
}
