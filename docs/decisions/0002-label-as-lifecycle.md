# 0002 — A label is the lifecycle, not a reaper

**Status:** accepted

## Context

Preview environments have to expire. A pull request left open for three weeks
should not hold capacity for three weeks, and something has to decide when it
stops.

## Decision

An environment exists exactly while its pull request carries the `preview`
label. CI grants the label; a scheduled job removes it once the pull request has
been idle past its TTL. Nothing ever deletes a namespace directly.

## Alternatives, and why not

**A cron job that deletes stale namespaces.** This is the obvious design and it
fights the controller. The ApplicationSet would notice the Application missing
and recreate it immediately, so the reaper and the controller would take turns
undoing each other — the environment flickering rather than expiring, and the
logs of both components looking individually reasonable.

**A TTL annotation the controller understands.** ArgoCD has no such thing, so
this means the custom controller rejected in ADR 0001.

## Consequences

- Expiry is a change in **desired state**, so the two cooperate instead of
  racing. The controller is never wrong; it is told something different.
- Re-adding the label brings the environment back, which makes expiry
  reversible and therefore safe to be aggressive about.
- The label is the entire lifecycle API. Everything that grants or withholds an
  environment — the fork check, the bot check, the per-repository cap — is
  implemented as a decision about whether to apply one label, in one place.
- The TTL clock is `updated_at`, so comments and reviews keep an environment
  alive. A pull request under active review does not expire mid-review, and
  nobody has to renew anything by hand.
- The cost: an environment can be resurrected by anyone who can label a pull
  request. That is the same set of people who could open one, so it grants
  nothing new — but it does mean the cap in `preview-lifecycle.yml` is a
  preventive control, not an enforcement one.
