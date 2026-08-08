# 0005 — Slugs are derived, never chosen

**Status:** accepted

## Context

Every environment needs a name that appears in a namespace and a hostname:
`<slug>-pr-<number>`. Pull request #1 exists in every repository ever created,
so without a per-repository prefix the second repository onboarded would take
over the first one's namespace.

## Decision

The slug is derived from owner and repository — lowercased, non-alphanumerics
collapsed to dashes, truncated to 45 characters with a six-character SHA-256
suffix when longer.

## Alternatives, and why not

**Let repositories choose.** With onboarding open to anyone, a chosen slug is
squattable: whoever asks for `app` first owns it and everyone else is stuck.
Deriving it makes it unique by construction and unarguable — there is no
allocation to contest, because there is no allocation.

## The failure this caused, and the guard

The rule is implemented three times, and it has to be:

1. `scripts/discover-repos.rb` — Ruby. Decides the hostname that **exists**.
2. `.github/workflows/preview-build.yml` — shell, inline. Decides the hostname
   the pull request comment **advertises**. It cannot share code with the
   others: adopters call that workflow from their own repository, where
   `actions/checkout` has checked out their code, not the platform's.
3. `scripts/lib/slug.sh` — shell, sourced by `init-platform.sh` so a fresh fork
   onboards itself under the slug the other two will derive.

When 1 and 2 disagreed, **every preview comment linked to a hostname that had
never existed** — on the single feature the whole platform is for, and with no
error anywhere, because both sides were behaving exactly as written.

`scripts/check-slug-agreement.sh` compares all three across nine cases,
including uppercase, dots, underscores, leading and trailing dashes, and names
long enough to trigger truncation. It also asserts the resulting
`<slug>-pr-99999` fits in a 63-character DNS label, and greps the workflow to
confirm its inline copy still contains the rule the retyped copy was written
against.

Copy 3 was added later, after `init-platform.sh` was found hardcoding the slug
`arcade` — which reintroduced exactly this bug for anyone who forked, and which
the two-way check could not see.

## Consequences

- Truncation needs a digest, because two long repository names sharing a prefix
  would otherwise collide silently.
- Three implementations is a real cost, paid deliberately, and it is only safe
  because something checks. Two implementations of one rule will drift; the
  question is only whether anything notices.
