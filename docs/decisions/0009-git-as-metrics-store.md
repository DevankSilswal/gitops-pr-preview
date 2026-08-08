# 0009 — Git as the metrics store for the platform's own SLI

**Status:** accepted

## Context

This project's README made a promise — open a pull request, get a working URL
in about a minute — and nothing measured it. "About a minute" was an
impression. Nobody could say what the p95 was, whether it had regressed, or what
any particular engineering decision had been worth.

That gap matters more than it looks. The webhook replacing ArgoCD's five-minute
poll, the wait-before-commenting, the retry backoff on image pulls: each is
either worth something against that number or it is decoration, and without the
number there is no way to tell which.

## Decision

Define the SLI as **seconds from the pull request being opened to its
environment serving 200**, and store every measurement as a line in
`metrics/provisioning.jsonl`, appended by CI through the GitHub contents API.
`scripts/slo-report.rb` computes percentiles and attainment.

Objective: 95% within 120 seconds.

## Why git, and not a time-series database

- **Prometheus is on the node**, and the node is the constrained resource
  (ADR 0004). Retention is two days, which is useless for a quarterly trend.
- **A hosted metrics service** costs money, which is the constraint this whole
  project is built under (`docs/cost.md`).
- **The history is auditable and diffable.** Every measurement is a commit.
- **Coherence.** For a project whose entire argument is that git holds the
  state — the deployment log is the history of `values-production.yaml`, the
  onboarded repositories are files, rollback is a revert — keeping its own
  metrics anywhere else would be incoherent.

The obvious objection is that this does not scale. It does not need to: at a
few hundred environments a year it is a file of a few hundred lines, and if the
platform ever outgrows that, outgrowing it is the good problem.

## Measurement details worth defending

- **From `pull_request.created_at`, not from job start** — for a first
  provision. The difference is the build, and the build is part of what a
  reviewer waits through. Measuring from job start would flatter the platform by
  excluding its largest component.
- **From the commit, for a redeployment.** The first real samples recorded
  1138s and 1567s for redeployments that took about a minute, because both were
  measured from `created_at` on a pull request that had been open for twenty.
  That measures the age of the pull request, not the speed of the platform, and
  grows without bound. The committer date of the commit under review is the
  closest exact answer to "when did somebody push this" — `updated_at` also
  moves on comments and reviews, which would make a redeployment look faster for
  having been discussed first.

  Worth stating plainly because it is the trap in any latency metric: a number
  that is easy to collect is not the same as the number the promise is about,
  and the difference only became obvious once real values arrived.
- **`provision` and `redeploy` are recorded separately.** A first environment
  and a push into one that already exists are different operations with
  different expected latencies, and averaging them describes neither. The
  objective is judged on first provisions, because that is the wait the promise
  is about.
- **Nearest-rank percentiles.** With small samples this always returns a value
  that was actually observed, rather than interpolating between two that were
  not.
- **Appends retry on conflict.** Concurrent builds race on the file; a 409 means
  re-read and try again rather than lose the sample.

## Consequences

- Every environment that comes up costs one small commit to `main`, so
  `metrics/provisioning.jsonl` is in `paths-ignore` or the commit would trigger
  another build, forever.
- The error budget can go negative, and it is meant to be able to. A negative
  budget is not a rounding detail — it says the platform is slower than it
  promised and latency is the next thing to work on.
- The weekly report does **not** fail on a miss. A scheduled report that goes
  red on a bad week is a report people learn to ignore; `--strict` exists for
  when that is genuinely wanted.
