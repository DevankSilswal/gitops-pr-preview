# 0013 — A worker beside the web process, and why not scale-to-zero

**Status:** accepted

## Context

Real applications are not one process. A queue consumer, a scheduler, a
migration runner. An environment that can only hold the web tier is a preview of
half the change, and reviewing the half that is not there is exactly the
guesswork previews exist to remove.

## Decision

An optional `worker`: the same image, a different command, no Service and no
Ingress. Opted into per repository with one line in `.github/preview.yml`:

```yaml
worker: "npm run worker"
```

Same image on purpose. That is how the shape almost always arrives — one
repository, one Dockerfile, several entry points — and a worker built from a
different commit than the page a reviewer is looking at would make the
environment lie about what it is running, which is the one thing this platform
is careful about above all else. `ROLE=worker` lets a single image branch
without a second build or a second tag.

## The lesson that repeated itself

The application's NetworkPolicy selects the application's pods. The worker does
not carry those labels, so **no policy selected it** — and a pod no policy
selects is unrestricted.

That is the third time this exact shape has appeared: the namespace ArgoCD did
not own and therefore could not prune; the database no policy covered; now the
worker. Adding a workload to this chart means asking what selects it, and the
answer is never "the thing that selects the other workload".

It gets its own policy: ingress denied entirely (an empty rule list, correct for
a process with no port), egress to DNS, the database if there is one, and the
same bounded outward access the web process has.

## Why not scale-to-zero

It was proposed alongside this, for roughly 4× effective capacity, and it is
being deliberately deferred rather than quietly dropped.

**It fights `selfHeal`.** Anything that sets replicas to 0 out of band gets
reverted within minutes, because desired state says 1 and ArgoCD's entire job is
to make that true. This is the same trap as the cron reaper in
[ADR 0002](0002-label-as-lifecycle.md), and the same fix would be needed:
idleness expressed as desired state — a second label the generator reads — not
as an imperative scale-down.

**Waking on request needs a component this node cannot afford.** Something has
to hold the connection while the pod starts. That is KEDA's HTTP add-on or
Knative, on a node that has already been taken down twice by installing
something that did not fit ([ADR 0004](0004-no-prometheus-operator.md)).

**And the capacity is not the constraint.** The node holds around 40
environments (`docs/capacity.md`), the alert fires at 12, and typical load is
two or three. Quadrupling a ceiling nothing is approaching, by adding a
component that has twice broken this node, to solve a problem the TTL sweep and
the nightly deallocation already handle — that is complexity bought with the one
resource actually in short supply.

Worth revisiting when the fleet is regularly above the alert threshold. Until
then the honest answer is that this optimises the wrong number.
