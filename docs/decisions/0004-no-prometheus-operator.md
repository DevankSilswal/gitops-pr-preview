# 0004 — No Prometheus operator and no Grafana

**Status:** accepted

## Context

Preview environments fail in ways nobody sees: an image tag that never
published, a pod that starts and never passes its probes, an environment that
quietly outgrows its quota. Something has to watch.

`kube-prometheus-stack` is the standard answer — operator, CRDs, Grafana,
dashboards, all configured together.

## Decision

Prometheus with `kube-state-metrics` and `node-exporter`. No operator, no
Grafana, no Alertmanager. Alerts are read through
`.github/workflows/alerts-to-issues.yml`, which polls from a GitHub runner and
opens an issue.

## What was actually measured

`kube-prometheus-stack` was installed on this node **twice**. Both times:

- load average past 9 on 2 vCPU
- the API server unable to answer its own health checks
- every preview URL down until the monitoring namespace was deleted

Nothing was OOMKilled either time. It is CPU, not memory, so trimming memory
limits — the obvious first response — changes nothing. The cost is mostly not
Prometheus: it is the operator reconciling CRDs, and Grafana, which is slow to
start and expensive to keep alive.

Dropping both leaves a scrape loop, `kube-state-metrics` and `node-exporter`,
which fits in roughly 120m.

## Alertmanager, separately

Also dropped, and for a second reason on top of the CPU: it would still need
somewhere to send alerts, and this project has no paging destination. Polling
the Prometheus API from a scheduled GitHub Actions job moves the work off the
node entirely onto minutes that are free, and lands alerts in the repository —
an open issue is a firing alert, closed when it recovers.

## Consequences

- No Grafana. Alerts and queries are read in Prometheus's own UI, which answers
  "is anything broken" and does not hand anybody a dashboard.
- `dashboard.yaml` is kept for a cluster with room, and `WITH_OBSERVABILITY=full`
  still installs the whole stack for anyone who has four vCPU.
- The alert rules live in a `PrometheusRule`, which is the operator's format, so
  `bootstrap-cluster.sh` and `check-alerts.sh` both lift `spec.groups` out of it
  rather than maintaining the rules twice.
- Alert delivery now depends on GitHub Actions being up and the cluster being
  reachable from a runner. The polling job distinguishes "nothing is firing"
  from "nothing answered" and leaves existing issues alone in the second case —
  a deallocated or evicted node is unreachable, not healthy.
- Retention is two days. Preview namespaces are short-lived, so a longer window
  mostly retains series for environments that no longer exist.
