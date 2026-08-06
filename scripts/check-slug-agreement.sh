#!/usr/bin/env bash
#
# The slug is derived twice: in Ruby by scripts/discover-repos.rb, which
# decides the hostname that exists, and in shell by the reusable build
# workflow, which decides the hostname the pull request comment advertises.
#
# When those disagreed, every comment linked to a hostname that had never
# existed — on the one feature this platform is for. Two implementations of one
# rule will drift; this is what notices.

set -euo pipefail

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

  if [ "$rb" = "$sh" ]; then
    printf 'ok   %-76s -> %s\n' "$case" "$rb"
  else
    printf 'FAIL %-76s\n     ruby=%s\n     shell=%s\n' "$case" "$rb" "$sh"
    failed=1
  fi

  # The whole `<slug>-pr-<number>` has to fit in one DNS label.
  label="${rb}-pr-99999"
  if [ ${#label} -gt 63 ]; then
    printf 'FAIL %s produces a %d-character DNS label\n' "$case" "${#label}"
    failed=1
  fi
done

exit "$failed"
