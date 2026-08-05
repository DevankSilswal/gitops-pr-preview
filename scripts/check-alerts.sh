#!/usr/bin/env bash
#
# Validate and unit-test the preview environment alerts.
#
# The rules live inside a PrometheusRule custom resource, which promtool cannot
# read directly, so its spec.groups are lifted out into the plain rule file
# promtool expects before the tests run against it.

set -euo pipefail

command -v promtool >/dev/null || { echo "promtool is required (brew install prometheus)" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/deploy/platform/observability"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ruby -ryaml -e '
doc = YAML.safe_load(File.read(ARGV[0]))
File.write(ARGV[1], { "groups" => doc.fetch("spec").fetch("groups") }.to_yaml)
' "$SRC/alerts.yaml" "$WORK/rules.yaml"

cp "$SRC/alerts.test.yaml" "$WORK/alerts.test.yaml"

promtool check rules "$WORK/rules.yaml"
promtool test rules "$WORK/alerts.test.yaml"
