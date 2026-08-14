# Security

This platform runs code from pull requests on a single self-hosted Kubernetes
node. The security model, the isolation boundaries and the things that are
**not** secure yet are documented in
[`docs/product/security.md`](docs/product/security.md).

## Reporting a vulnerability

Please report privately rather than opening a public issue: open a
[security advisory](https://github.com/DevankSilswal/gitops-pr-preview/security/advisories/new)
on this repository, or contact the repository owner directly.

Please include what you did, what happened, and what you expected. A proof of
concept helps; please do not run one against the live cluster beyond what is
needed to demonstrate the issue, and do not access data belonging to anyone
else.

There is no bug bounty. This is a personal project run on a student credit.

## What to expect

An acknowledgement within a few days, an assessment of whether the issue is
reproducible, and a fix or an explicit decision not to fix, with reasoning. If
the issue affects the live cluster it will be mitigated before it is discussed
publicly.

## Known and accepted weaknesses

These are documented rather than hidden, and are not useful as vulnerability
reports:

- **Preview environments are publicly reachable by anyone with the URL.**
  Private previews are implemented but not enabled — the cluster has no secret
  salt, so no password can be derived.
- **Single node, no high availability.** Losing the VM takes every environment
  with it. Recovery is documented in [`docs/runbook.md`](docs/runbook.md) and
  requires a human.
- **No product authentication**, because the product layer does not exist yet;
  the cluster is administered with a kubeconfig.

## Compliance

No compliance certification is claimed or implied. This project is not SOC 2,
ISO 27001, HIPAA or GDPR certified.

## Data handled

The GitHub integration reads repository metadata, pull request state and
commit SHAs, and writes labels and comments on pull requests. No source code is
stored by the platform beyond the container images built from it, and no
personal data is collected beyond the GitHub identity of users who sign in.
Everything runs on infrastructure the operator controls.
