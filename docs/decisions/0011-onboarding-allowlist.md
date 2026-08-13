# 0011 — An allowlist decides who may run code here

**Status:** accepted, and it supersedes part of the self-service story in
[0003](0003-chart-from-platform.md)

## Context

Onboarding was open by construction: discovery searched GitHub for the
`pr-preview` topic, and anyone can add a topic to their own repository. Add
`.github/preview.yml` too and, within the hour, containers from that repository
were being scheduled here.

That was the feature. "No cloud account, no Kubernetes, nobody to ask" is the
line the README leads with, and it is genuinely the most distinctive thing about
this platform.

It is also, stated plainly, an open invitation to run arbitrary containers on a
stranger's machine, billed to a stranger's cloud account, egressing from a
stranger's IP address.

## The gap the other controls do not cover

Every existing control bounds what a preview can *do* once it exists:

| Control | Bounds |
|---|---|
| NetworkPolicy | what it can reach |
| ResourceQuota, LimitRange | what it can consume |
| Restricted Pod Security Admission | what privileges it can hold |
| AppProject | what it can create |

None of them answers **who may start one**. That question does not end with a
compromised cluster — the isolation is genuinely decent — it ends with a
suspended Azure subscription, because the abuse that matters here is not
breaking out of a namespace. It is a few dozen repositories quietly mining, or
scanning, or relaying, from an address that belongs to the operator.

The CPU limit makes mining unprofitable. It does nothing about the abuse report.

## Decision

`deploy/platform/allowlist.yaml` lists owners. Discovery skips anyone not on it,
before it even fetches their config. Missing, malformed or empty allowlist
onboards nobody.

## What this costs, honestly

The self-service claim gets weaker and has to be restated accurately. It is no
longer "nobody approves". It is:

> Joining is a pull request against one file. Still a commit and nothing else,
> still no ticket, no meeting and no account to create — and one review by
> somebody who is accountable for the machine.

That is the smallest amount of gatekeeping that separates an open platform from
an open relay, and pretending otherwise in the README would be the kind of claim
that survives right up until it does not.

The mechanism is unchanged: adding an owner is a commit, discovery notices,
ArgoCD reconciles, nothing is run against the cluster. Removing one offboards
every repository they had on the next run.

## Consequences

- Fails closed. The permissive failure is the one that costs a subscription, so
  an unreadable allowlist stops discovery rather than opening it.
- Owner-level, not repository-level. A given owner is either trusted with this
  cluster or is not; making them list each repository would be friction without
  a matching reduction in risk.
- Compared case-insensitively, because GitHub usernames are case-preserving but
  not case-sensitive and a near-miss here would be baffling to debug.
- The allowlist is the audit trail. `git log` on that one file answers who was
  admitted, by whom, and when.
