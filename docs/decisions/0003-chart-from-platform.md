# 0003 — The chart comes from the platform, never the pull request

**Status:** accepted

## Context

A preview environment deploys a Helm chart. The chart could come from the
repository under review — which is convenient, because each application could
then describe its own deployment — or from the platform.

It originally came from the branch under review.

## Decision

The chart is read from the platform repository at a pinned revision. A pull
request controls **what** is deployed (the image tag) and never **how**.

## Why this is not a preference

Under ArgoCD's `default` project — which permits every repository, every
namespace and every resource kind — anyone able to open a pull request could
add a file to `charts/preview-app/templates/`:

```yaml
kind: ClusterRoleBinding
# ... bind cluster-admin to a ServiceAccount the pull request also creates
```

and ArgoCD would apply it with ArgoCD's own privileges. Opening a pull request
would mean owning the cluster. On a platform whose stated purpose is running
unreviewed code from repositories the operator does not control, that is not a
hardening opportunity; it is the whole threat model.

## The layered response

One change would not have been enough, so there are four:

1. **The chart comes from the platform.** A pull request cannot add a template.
2. **Previews run under their own AppProject**, not `default` — scoped to the
   chart repository, `*-pr-*` namespaces, and a resource list containing
   nothing that grants permissions.
3. **`ServiceAccount`, `Role` and `RoleBinding` are explicitly blacklisted.**
   Whitelists drift as features are added; this one says what must never
   happen regardless.
4. **Restricted Pod Security Admission is enforced by the API server**, so the
   kubelet refuses what the chart merely declines to ask for.

## Consequences

- Adopters vendor nothing. Onboarding is a topic and a six-line config file.
- The chart has to be general enough for every onboarded application, which is
  why port and health path are values rather than conventions. This is a
  feature: a chart that only works for one application is not a platform.
- An application needing something the chart does not template cannot have it
  without a change to the platform. That is the intended trade — the alternative
  is arbitrary manifests from unreviewed branches.
- `Secret` was moved off the blacklist to support private previews (ADR 0006).
  The distinction held: a Secret grants no caller any ability, while a
  ServiceAccount, Role or RoleBinding does.
