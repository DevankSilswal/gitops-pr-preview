# 0014 — SQLite for the control plane, and why not Postgres

**Status:** accepted

## Context

The product layer needs a database: projects, repositories, previews,
deployments, policies, memberships, audit and webhook idempotency. The obvious
choice is Postgres, which this repository already knows how to run — the preview
chart can provision an ephemeral one per environment.

The constraint is the node. Measured on 2026-08-14, before anything was added:

```
memory   2918Mi / 4006Mi   74%
free     ~1.05 GB
CPU      4% actual, 28% requested
disk     11.3 / 32.2 GB
```

The budget this project holds itself to is 70% sustained memory, so the node is
already over it. The largest consumers are Prometheus at 447Mi and the ArgoCD
application controller at 315Mi.

A Postgres server for the control plane costs roughly 150–250Mi resident once
it has warmed up, plus a pod, a PVC and a backup story. With an API process at
roughly 80–120Mi that is 250–350Mi of new sustained memory — taking the node to
somewhere between 81% and 83%.

## Decision

The control plane uses **SQLite**, in the API process, on a persistent volume.

Prometheus moves to the lighter configuration already present in the repository
at `deploy/platform/observability/values-lite.yaml`, which is expected to
release roughly 300Mi.

Together these keep sustained memory near 75% rather than 83%, and add one pod
to the cluster instead of two.

## Why this is not a compromise disguised as a decision

The workload genuinely suits it. This is a single-node platform serving a small
team: writes arrive at the rate humans open pull requests, the working set is
kilobytes, and there is exactly one process that ever writes. SQLite in WAL mode
handles that with room to spare, and the operational properties are better than
Postgres at this size — the backup is a file copy, the restore is a file copy,
and there is no second process to be down.

The honest trade is that it is single-writer and lives on one node's disk. Both
are already true of everything else here: there is one node, and if it is lost,
ArgoCD rebuilds the cluster from git regardless.

## Alternatives, and why not

**Postgres now.** Correct at a scale this product does not have, and it would
push the node past the budget this project set itself. Adopting it would mean
either exceeding the budget or removing monitoring to make room — trading real
observability for theoretical scale.

**Postgres on a second VM.** Doubles the infrastructure bill for a database
that will hold a few thousand rows, on a project running on a student credit.

**A bigger VM.** `Standard_B2als_v2` → 8 GB roughly doubles the compute bill.
Worth revisiting when the control plane exists and its real appetite is
measured, rather than in advance of it.

**No database — derive everything from Kubernetes and GitHub.** Tempting, and
wrong. Audit history, policy, membership and provisioning history have no home
in either system, and a product whose state disappears when a namespace is
pruned cannot answer "what happened last Tuesday".

## Consequences

- Persistence is a module boundary. Every query goes through a repository
  interface, and no SQL leaks into a handler. Moving to Postgres later becomes a
  new implementation of that interface plus a migration, not a rewrite.
- Migrations are forward-only numbered SQL files applied at startup in a
  transaction, matching the shape `node-pg-migrate` already gives the preview
  database — one mental model, not two.
- The database file lives on a PersistentVolume and is backed up by copying it.
  Losing it loses product history, not any running environment: previews,
  namespaces and URLs are reconstructed from GitHub and the cluster.
- The 70% budget stays a real constraint rather than a number quietly abandoned
  the first time it was inconvenient. Prometheus being trimmed to make room is
  part of this decision, not a separate one, and if that trim does not release
  what it is expected to, this decision needs revisiting before the control
  plane ships.
