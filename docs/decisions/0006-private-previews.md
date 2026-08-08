# 0006 — Basic auth with a derived password, not oauth2-proxy

**Status:** accepted

## Context

Every preview environment was a public URL on a guessable hostname
(`<slug>-pr-<number>.<base>`), reachable by anyone and indexable by any
crawler. Unreleased work, on the open internet.

That is a dealbreaker for any team with something not yet announced, and it was
the largest single gap against the commercial platforms this project is
measured against.

## Decision

HTTP basic auth at the ingress, with a password **derived** from a cluster-wide
salt plus the environment's identity, delivered in the pull request's own
pinned comment. Plus `X-Robots-Tag: noindex` on every response, independently.

## Why the password is derived rather than generated

A generated password has to be stored and then read by whoever needs to tell
the reviewer what it is. CI cannot read it — CI has no cluster credentials, and
giving it some would undo the property the whole pipeline is built around.

So both sides compute it instead:

```
password = sha256(salt | environment | prNumber | "basic-auth")[0..20]
```

The chart computes it at render time; CI computes the same value from the same
salt held as a repository secret. Neither ever talks to the other, and the salt
never appears in git.

This also solves a problem specific to ArgoCD: a password generated with
`randAlphaNum` would differ on every render, so `selfHeal` would rewrite the
Secret forever and the Application would never report `Synced`. Deriving makes
the render deterministic.

bcrypt still salts randomly, so the Secret's *ciphertext* differs per render
even though the password does not. The ApplicationSet handles that with
`ignoreDifferences` on `/data/auth` — the one place the drift is expected and
harmless.

## Why delivery is the pull request comment

Whoever can read the pull request gets the password; whoever cannot, does not.
GitHub's permissions already answer "who is allowed to see this change", so
reusing that answer means the platform stores no user list, runs no identity
provider, and has nothing to revoke when somebody leaves a team.

## Alternatives, and why not

**oauth2-proxy with GitHub identity, scoped to repository collaborators.** This
is the better product — real identity, per-user audit, revocation that means
something. It does not fit: a second deployment per environment plus a cookie
secret or a redis, on a two-vCPU node already taken down twice by adding
components (ADR 0004). It is the documented upgrade path for a cluster with
room.

**Unguessable hostnames instead of a password.** The hostname has to be
derivable by the ApplicationSet, CI and the reviewer, so it cannot carry
entropy nobody is told.

**`configuration-snippet` for the noindex header.** Would work, and enabling
snippet annotations lets *any* Ingress in the cluster inject arbitrary nginx
configuration. On a cluster whose purpose is running other people's unreviewed
code, that is handing out the ingress controller. The supported
`custom-headers` mechanism plus a one-name allowlist
(`global-allowed-response-headers=X-Robots-Tag`) does the same job without it.

## Consequences

- `Secret` had to move from the AppProject blacklist to the whitelist. The
  distinction is stated in ADR 0003 and holds: a Secret grants no caller any
  ability; a ServiceAccount, Role or RoleBinding does.
- A cluster with no salt configured turns auth **off** rather than deriving a
  password from a known value, and the pull request comment says so plainly
  rather than implying protection that is not there.
- The noindex header is deliberately independent of the password. A mistake in
  the auth annotations should not also mean the environment gets crawled, and a
  crawler already let in cannot be un-told.
- `e2e-test.sh` asserts all of it behaviourally: 401 without credentials, 200
  with the password derived exactly as CI derives it, and the header present.
