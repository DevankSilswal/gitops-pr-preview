# 0001 — ApplicationSet PR generator, not a custom controller

**Status:** accepted

## Context

Something has to notice that a pull request exists and turn that into a running
environment. The obvious implementations are a controller written for the job,
a CI step that runs `helm install` against the cluster, or ArgoCD's
ApplicationSet with its pull request generator.

## Decision

The ApplicationSet, with a matrix of a git file generator over
`deploy/platform/onboarded/*.yaml` crossed with a pull request generator per
repository.

## Alternatives, and why not

**A CI step that deploys.** The pipeline would need cluster credentials. That
single fact undoes the property the whole project is about: the cluster pulls
its own desired state from git and CI never touches it. It also makes teardown
imperative — something has to remember to delete what it created, and anything
that has to remember eventually forgets. Namespaces leaked exactly this way
before `CreateNamespace=true` was removed.

**A custom controller.** More capable, and the capability is not needed. It
would be another component to build, deploy, monitor and keep upright on a node
that has no room, in exchange for behaviour ArgoCD already implements. Writing
an operator to avoid learning a generator is a common and expensive mistake.

## Consequences

- Per-pull-request environments are declarative. The set of environments is a
  function of the set of labelled pull requests, evaluated continuously.
- Teardown needs no code at all: the generator stops emitting, the controller
  deletes, the finalizer cascades.
- The cost is a real constraint — whatever the generator does not expose cannot
  be done. `requeueAfterSeconds` polling was the price until the webhook in
  `deploy/argocd/webhook-ingress.yaml` replaced it.
- Debugging is one level removed. When an environment does not appear, the
  question is why the generator did not emit it, which is a less direct thing to
  inspect than a log line in a controller written for this.
