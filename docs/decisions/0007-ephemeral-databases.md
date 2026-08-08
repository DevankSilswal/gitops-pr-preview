# 0007 — Ephemeral databases per pull request, on emptyDir

**Status:** accepted

## Context

A preview environment that cannot hold data is a demo of a preview environment.
Most real applications need a database, and without one this platform serves
only stateless samples.

This is also where the commercial platforms are weakest. Vercel and Netlify
point every preview at one shared branch database, so two pull requests running
conflicting migrations corrupt each other's review. A database created and
destroyed with the environment does not have that problem — which makes this
one of the few places a self-managed platform is straightforwardly *better*
rather than merely equivalent.

## Decision

An opt-in Postgres Deployment in the environment's own namespace, backed by
`emptyDir`, with its own NetworkPolicy. `DATABASE_URL` is injected into the
application. The platform supplies an empty database; migrating and seeding it
is the application's job on startup.

## Why emptyDir and not a PersistentVolumeClaim

A volume per pull request on a single node is not available at any price. More
importantly, durability is the wrong property: a preview database should be
reconstructible from migrations and fixtures, not accumulated. Data resetting
when the pod restarts is correct behaviour, not a limitation — it is what makes
the environment reproducible.

`Recreate` rather than `RollingUpdate`, because two Postgres pods would not
share one `emptyDir`; each would get its own, and a rolling update would hand
connections to an empty database mid-rollout.

## Why the platform does not seed it

Reading a fixture from the branch under review would put pull-request-controlled
content back into the deploy path, which is exactly what ADR 0003 exists to
prevent. Applications already migrate themselves on startup; asking them to do
what they already do keeps the chart generic and the trust boundary intact.

## Why the password is not a Secret object

The boundary protecting this database is the NetworkPolicy, which admits only
the application pods in this one namespace. Nothing else can open a connection
to try a password at all. Given that, a derived password in an environment
variable is honest about where the security actually lives — and it avoids
needing a second Secret in a project deliberately kept narrow.

## The subtlety worth recording

The application's NetworkPolicy selects the application's pods, so it says
nothing about the database's. **A pod that no policy selects is unrestricted** —
which would have left the database reachable from every other preview
environment on the cluster, the exact opposite of the point.

So the database gets its own policy: ingress from the application pods in this
namespace only, egress to DNS only. This is easy to miss and produced no
symptom that would have surfaced without looking for it.

## Consequences

- No new AppProject permissions. A Deployment and a Service were already
  whitelisted, which is a good sign the design fits the platform rather than
  fighting it.
- Off by default. It is the most expensive thing this chart will schedule, and
  most applications do not need one — see `docs/capacity.md`.
- `readOnlyRootFilesystem` is inherited from the application's container
  context, so every path Postgres writes to has to be granted explicitly. The
  unix socket directory (`/var/run/postgresql`) is the one that is easy to
  forget: without it the server starts and then fails its own readiness probe.
- `postgres:17-alpine` rather than the Debian image, because it is pulled onto a
  single small node once per environment and the difference is around 250 MB
  each time.
