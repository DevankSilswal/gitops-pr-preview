#!/usr/bin/env bash
#
# Syntax-check the JavaScript embedded in actions/github-script steps.
#
# That code is a YAML string, so nothing checks it: a missing brace is invalid
# YAML to no one and a perfectly good workflow file to everyone, and the error
# only appears minutes into a run that had already started doing real work.
#
# github-script wraps the body in an async function, so `await` at the top
# level is legal here and the check has to allow for it.

set -euo pipefail

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v ruby >/dev/null || { echo "ruby is required" >&2; exit 1; }

ruby -ryaml -rjson -e '
scripts = []
Dir[".github/workflows/*.yml"].sort.each do |file|
  doc = YAML.safe_load(File.read(file))
  (doc["jobs"] || {}).each do |job_name, job|
    (job["steps"] || []).each do |step|
      body = step.dig("with", "script")
      scripts << { "file" => file, "job" => job_name, "src" => body } if body
    end
  end
end
print JSON.dump(scripts)
' | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const scripts = JSON.parse(raw);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let failed = 0;

  for (const s of scripts) {
    try {
      new AsyncFunction("context", "github", "core", "process", s.src);
      console.log(`ok   ${s.file} :: ${s.job}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${s.file} :: ${s.job}\n     ${e.message}`);
    }
  }

  if (!scripts.length) {
    console.error("no github-script blocks found — has the workflow layout changed?");
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
});
'

# The fork preview path is two workflows that have to agree, and nothing else
# checks that they do.
#
# Stage one builds the fork's code with no credentials and uploads an artifact;
# stage two, running from the default branch where a pull request cannot touch
# it, downloads that artifact and pushes it. If the artifact name drifts on
# either side, stage one keeps passing and stage two fails minutes later on a
# contributor's pull request — or worse, silently publishes nothing while the
# label says an environment is coming.
#
# The name is the contract. This asserts both ends still spell it the same way,
# and that the security properties the split depends on are still in place.
echo
ARTIFACT=fork-preview-image
STAGE_ONE=.github/workflows/build.yml
STAGE_TWO=.github/workflows/fork-preview-publish.yml

fork_failed=0
fork_check() {
  if eval "$2" >/dev/null 2>&1; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s\n' "$1"
    fork_failed=1
  fi
}

fork_check "stage one uploads '$ARTIFACT'" \
  "grep -q 'name: $ARTIFACT' '$STAGE_ONE'"
fork_check "stage two looks for '$ARTIFACT'" \
  "grep -q \"'$ARTIFACT'\" '$STAGE_TWO'"

# The property the whole design rests on: workflow_run executes the definition
# from the default branch, so a fork can change what stage one builds and not a
# line of what stage two does with it. Any other trigger loses that.
fork_check "stage two is triggered by workflow_run" \
  "grep -q 'workflow_run:' '$STAGE_TWO'"

# If stage one ever gains a secret or a registry login, the split stops being a
# split: the fork's code would execute with something worth stealing.
fork_check "stage one's fork job holds no registry login" \
  "! awk '/^  fork-image:/,/^  [a-z-]+:\$/' '$STAGE_ONE' | grep -q 'login-action'"
fork_check "stage one's fork job does not push" \
  "! awk '/^  fork-image:/,/^  [a-z-]+:\$/' '$STAGE_ONE' | grep -q 'push: true'"

# A maintainer's decision, read on the side a pull request cannot edit.
fork_check "stage two requires the safe-to-preview label" \
  "grep -q 'safe-to-preview' '$STAGE_TWO'"

exit "$fork_failed"
