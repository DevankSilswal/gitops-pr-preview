# 0010 — Fork previews via `workflow_run`, not `pull_request_target`

**Status:** accepted

## Context

Pull requests from forks got no preview environment. The reasoning was sound: a
fork's build runs with a read-only token that cannot publish to the registry, so
labelling one would produce an environment stuck in `ImagePullBackOff`.

But "no previews for external contributors" is a hard limit for anything
open-source facing — and an external contribution is exactly when a reviewer
most wants to click something rather than read a diff from someone whose
judgement they do not yet know.

## Decision

Split the work in two, and gate it on a maintainer's label:

1. **`build.yml`, on `pull_request`** — builds the fork's code with no secrets,
   no registry login and a read-only token, writing the image to a tarball
   uploaded as an artifact. It cannot push anything anywhere.
2. **`fork-preview-publish.yml`, on `workflow_run`** — holds the write token,
   downloads that artifact, and pushes it. It never checks out or executes the
   fork's code; it only moves bytes stage one produced.

A maintainer must apply `safe-to-preview` before stage two proceeds.

## Why not `pull_request_target`

This is the tempting fix and it is the well-known supply-chain hole.
`pull_request_target` runs with the base repository's permissions and secrets.
Checking out and building the pull request's head under it means executing an
unreviewed branch with a token that can push images and write to the
repository — anyone able to open a pull request would own the registry.

`preview-lifecycle.yml` already uses `pull_request_target` correctly, for a job
that reads event metadata and never touches the code, with a comment saying so.
The distinction is the entire point.

## The property that makes this sound

**`workflow_run` executes the workflow definition from the default branch**, not
from the pull request. A fork can change what stage one builds; it cannot change
a single line of what stage two does with the result.

That is the whole security argument, and it is why the label check lives in
stage two. A check that a fork could edit is not a check.

Two supporting details:

- The pull request is looked up **by head SHA**, not taken from anything the
  fork controls in the artifact.
- The image tag is **rebuilt** in stage two from that looked-up SHA, so a fork
  that tampered with the tarball cannot make it land on another pull request's
  tag.

## Consequences

- Fork previews need a human decision. That is intended: running unreviewed code
  on a shared cluster should be somebody's call, not automatic.
- The fork path is slower — a build, an artifact round-trip, then a push. It
  builds `linux/amd64` only, since emulated arm64 on a runner would double it
  again for a node that is x86.
- Two workflows have to stay in step. If stage one stops producing
  `fork-preview-image`, stage two fails loudly rather than silently publishing
  nothing.
- Artifacts are retained one day. They exist only to cross the trust boundary.
