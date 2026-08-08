# Decision records

Why this platform is shaped the way it is, one decision per file.

Most of the reasoning here already existed as comments next to the code it
justified, which is the right place for it and the wrong place to find it. A
decision that spans four files — the chart, the ApplicationSet, the workflow and
the project — has no single line to sit next to.

Each record states what was decided, what it was decided *against*, and what
that cost. The rejections are the useful part. Anyone can list what a system
does; what tells you whether the choices were considered is knowing what was
tried and put back.

| # | Decision |
|---|---|
| [0001](0001-applicationset-pr-generator.md) | ApplicationSet PR generator, not a custom controller |
| [0002](0002-label-as-lifecycle.md) | A label is the lifecycle, not a reaper |
| [0003](0003-chart-from-platform.md) | The chart comes from the platform, never the pull request |
| [0004](0004-no-prometheus-operator.md) | No Prometheus operator and no Grafana |
| [0005](0005-derived-slugs.md) | Slugs are derived, never chosen |
| [0006](0006-private-previews.md) | Basic auth with a derived password, not oauth2-proxy |
| [0007](0007-ephemeral-databases.md) | Ephemeral databases per pull request, on emptyDir |
| [0008](0008-spot-capacity.md) | Spot capacity, and a watchdog off the node |
| [0009](0009-git-as-metrics-store.md) | Git as the metrics store for the platform's own SLI |
| [0010](0010-fork-previews.md) | Fork previews via workflow_run, not pull_request_target |
