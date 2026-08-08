# metrics

`provisioning.jsonl` is the platform's own service level indicator: seconds from
a pull request being opened to its environment serving 200.

One JSON object per line, appended by the `record-sli` job in
`.github/workflows/build.yml` every time an environment comes up. Read it with
`make slo`, or `scripts/slo-report.rb --markdown` for the weekly report.

```json
{"at":"...","pr":31,"kind":"provision","seconds":143,"tag":"pr-31-..."}
```

`kind` is `provision` for a pull request's first environment and `redeploy` for
a push into one that already exists. They are recorded separately because they
are different operations with different expected latencies, and the objective is
judged on first provisions — that is the wait the promise is about.

**The file starts empty and fills up as pull requests are built.** It is
deliberately not seeded: numbers here are measurements, and a measurement that
was invented to make a report look populated is worse than no report. If
`make slo` says there are no measurements yet, that is correct and it will fix
itself on the next preview environment.

Why a file in git rather than a time-series database:
[ADR 0009](../docs/decisions/0009-git-as-metrics-store.md).
