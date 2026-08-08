# 0008 — Spot capacity, and a watchdog that lives off the node

**Status:** accepted

## Context

Compute is the entire bill for this platform — the disk and the static IP
together cost less than two days of the VM running on demand. The project has to
survive on a student credit and then on nothing.

## Decision

Run the node on Azure Spot capacity with `eviction_policy = "Deallocate"` and
`max_bid_price = -1`, deallocate it nightly on a free DevTest schedule, and
restart it after an eviction from a scheduled GitHub Actions job.

Roughly a tenth of the on-demand price, and about half of what remains again
from the nightly window.

## Why this is defensible here and would not be elsewhere

Spot is normally an unacceptable trade for anything serving a public URL. It is
acceptable here for one specific, already-demonstrated reason: **this platform
rebuilds itself from git**. The VM has been destroyed and recreated with
production and every preview environment restored by `bootstrap-cluster.sh`
alone, and the public IP is static so no hostname changes.

An eviction is a strictly easier version of that path — `Deallocate` keeps the
OS disk, so k3s comes back with its own state and ArgoCD reconciles the rest
from the repository.

Put the other way round: the cost saving is *available* because a property was
already true. A platform that could not rebuild itself could not take this
trade, and buying the discount would mean accepting real downtime rather than
minutes.

## The part that was actually missing

Recovery was never the problem. **Noticing** was — a deallocated VM does not
restart itself, and nothing would have reported it.

`.github/workflows/spot-watchdog.yml` polls every ten minutes and starts it.
It runs on GitHub's free minutes, which is not incidental: a watchdog on the
node it is watching is not a watchdog. It uses OIDC federation rather than a
stored credential, so there is no secret to leak or rotate.

It also knows about the nightly shutdown window and will not undo it. Restarting
the VM ten minutes after the schedule deallocated it would cost more than the
spot discount saves — which is a mistake this design makes very easy to make.

## Consequences

- An eviction means minutes of downtime, not seconds. Azure gives 30 seconds'
  notice, so nothing can make this seamless, and the goal is "minutes" rather
  than "however long until somebody looks".
- `use_spot = false` restores on-demand capacity for a demo that cannot be
  interrupted. Everything else in the repository behaves identically.
- The watchdog confirms production answers after a restart rather than assuming
  it. A start that leaves the API unreachable is worth knowing about.
- Setting `AZURE_CLIENT_ID` is what enables the watchdog; leaving it unset
  disables the job rather than failing it, so a fork without Azure credentials
  does not get a permanently red workflow.
- This makes the resilience story real rather than theoretical: the platform is
  evicted periodically by Azure, in production, and comes back without help.
  `scripts/chaos-test.sh` exercises the same class of failure deliberately.
