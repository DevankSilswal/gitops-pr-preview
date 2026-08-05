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
