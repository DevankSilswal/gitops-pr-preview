# Capacity

How many preview environments this cluster holds, where each limit lives, and
why they are the numbers they are.

This document exists because they used to disagree. The discovery script's own
comment reasoned about serving ten repositories while the workflow that runs it
shipped a default of twenty; the fleet alert fired above eight while the caps
underneath it permitted far more than eight. Every number was defensible on its
own and no two of them described the same cluster.

## The node

One `Standard_B2als_v2`: 2 vCPU, 4 GB, running k3s.

Overhead of the platform itself, from the requests each component declares:

| Component | CPU requested | Notes |
|---|---:|---|
| ArgoCD (server, repo-server, controllers) | ~600m | The largest single consumer |
| ingress-nginx | ~100m | |
| Prometheus (lite: no operator, no Grafana) | ~120m | `values-lite.yaml`, and see ADR 0004 |
| kube-state-metrics, node-exporter | ~20m | |
| k3s itself | ~200m | |

That leaves roughly **1,000m of 2,000m** for preview environments. Each requests
`25m` CPU and `48Mi` memory, so the requests-based ceiling is around **40**
concurrent environments — memory reaches a similar figure first if every
environment also runs a database.

Two caveats, and they matter:

- **Requests are what the scheduler counts, not what a busy environment
  burns.** Forty is an arithmetic ceiling and the practical one is lower.
- **These figures are declared requests, read off the charts — not observed
  usage.** Confirm them against the running node before treating them as the
  capacity model:

  ```bash
  kubectl top nodes
  kubectl top pods -A --sort-by=cpu
  kubectl describe node | sed -n '/Allocated resources/,/^Events/p'
  ```

  The number that should actually drive this is the SLO in
  `metrics/provisioning.jsonl`. If provisioning latency degrades as the fleet
  grows, the node is the constraint and the limits below are too high —
  whatever the arithmetic says.

## The limits, and what each is for

| Limit | Value | Where | Purpose |
|---|---:|---|---|
| Environments per adopting repository | 3 | `preview-build.yml` input `max-environments` | Stops one repository monopolising a shared cluster |
| Environments for this repository | 8 | `preview-lifecycle.yml` `MAX_ENVIRONMENTS` | Same, for the repository that owns the platform |
| Repositories served | 10 | `discover-repos.rb` and `discover.yml` | Bounds how many repositories can contribute at all |
| Fleet alert | above 12 | `TooManyPreviewEnvironments` | Notices the aggregate, early |
| Pods per environment | 4 | chart `quota.hard` | Room for the application, a database, and a rollout |

## Why they do not multiply to something safe

Ten repositories at three environments each is thirty, which is more than the
alert threshold and less than the measured ceiling. That is the honest
arithmetic, and caps that multiplied safely would have to be so small as to be
useless — one repository, two environments.

So the design is two-layered, and the layers do different jobs:

- **The caps are preventive.** They stop any single repository taking capacity
  everyone else needs. They are not a global budget and were never able to be
  one, because the platform onboards repositories it does not control and
  cannot see how many pull requests they are about to open.

- **The alert is the backstop.** It fires at 12, a third of the ceiling,
  because an alert that fires when the node is already full arrives too late to
  do anything with. There is time to expire something before pods start going
  Pending.

- **Pending pods are the failure mode, deliberately.** A heavy application
  meeting a full node gets pods that will not schedule. That is visible, it is
  local to the environment that caused it, and it does not take the cluster
  down with it. The alternative — no quota, first-come-first-served on the
  node — takes everybody's environments out together.

## Changing them

Raise the fleet alert and the per-repository caps together, or the alert stops
meaning anything. If the node is genuinely too small, the honest fix is a
bigger node: `docs/cost.md` has what each size costs, and ADR 0004 covers what
happened the two times something was installed that did not fit.
