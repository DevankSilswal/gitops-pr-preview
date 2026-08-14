# StackPreview — security design

This platform runs other people's code on a machine somebody pays for. That is
the whole threat model in one sentence, and most of what follows is a
consequence of it.

The failure that matters most is not a compromised preview. It is a compromised
*subscription*: a few dozen repositories quietly mining or scanning from an
address that belongs to the operator. That ends with the cloud account
suspended and every environment gone, which is why admission is controlled
before anything is fetched, let alone run.

---

## Threat model

| Threat | Vector | Control | State |
|---|---|---|---|
| Malicious pull request | attacker opens a PR against an onboarded repository | onboarding allowlist; only approved repositories are served at all | **LIVE** (ADR 0011) |
| Malicious fork | fork PR runs with repository credentials | forks build with a read-only token in a separate workflow stage; no registry write, no secrets | **LIVE** |
| Untrusted code escaping its environment | container escape, privilege escalation | Pod Security Admission, no privileged containers, no hostPath, no host network, dropped capabilities | **LIVE** |
| Lateral movement between previews | one environment reaching another | NetworkPolicy per namespace: ingress only from the ingress controller | **LIVE** |
| Reaching the node or the control plane | preview calls the Kubernetes API or the node | NetworkPolicy denies private ranges; no ServiceAccount token mounted in preview pods | **LIVE** |
| Outbound abuse — mining, scanning, spam | preview opens arbitrary outbound connections | egress restricted to 80, 443 and DNS | **LIVE** |
| Resource exhaustion | one preview starves the node | ResourceQuota and LimitRange per namespace; global environment cap | **LIVE** |
| Secret leakage into git | credentials committed | no secrets in git; generated at bootstrap; drift checker reads Secrets as metadata only | **LIVE** |
| Webhook spoofing | forged GitHub events | HMAC-SHA256 over the raw body, timing-safe compare | **NOT IMPLEMENTED** — no GitHub App yet |
| Cross-project access | user reads another organization's previews | server-side authorization per resource on every request | **NOT IMPLEMENTED** — no users yet |
| GitHub token abuse | a token with more scope than needed | fine-grained, least privilege, short-lived installation tokens | **PARTIAL** — today a read-only PAT in the cluster |
| Unauthorized preview access | anyone with the link opens a private preview | basic auth at the ingress with a derived password | **CODE ONLY** — no `secretSalt` on the cluster |
| Supply chain | a dependency in the preview image | out of scope for V1; the image is the repository's own responsibility | **NOT IMPLEMENTED** |

---

## The fork boundary

Forks get a strictly weaker trust model, and the reason is specific: a
`pull_request_target` workflow runs with write credentials against a branch the
attacker controls. That is the best-known supply-chain attack on GitHub Actions,
and this repository is deliberately shaped so it cannot happen:

- The job that labels pull requests runs on `pull_request_target` and **never
  checks out or executes the pull request's code**. It reads event metadata and
  the base branch's own scripts, at an explicitly pinned ref.
- Fork builds run in a separate stage with a read-only token. They cannot push
  an image, so a fork preview requires a maintainer to opt in.
- The preview chart always comes from the platform repository, never from the
  pull request under review. A pull request can change **what** is deployed; it
  can never change **how**. Without that, anyone able to open a PR could add a
  ClusterRoleBinding to the chart and have ArgoCD apply it with ArgoCD's
  privileges.

`fork_policy` in project policy is `deny | approve | allow`, defaulting to
`approve`. `allow` exists for repositories where every contributor is already
trusted; it is not the default and the product should say what it means.

## Isolation, concretely

Every preview environment is one namespace containing:

- **ResourceQuota** — pods, CPU and memory ceilings
- **LimitRange** — a default per container, so an unspecified workload cannot take the quota
- **NetworkPolicy** — ingress only from `ingress-nginx`; egress to 80/443/DNS, private ranges denied
- **Pod Security Admission** labels — enforced at the namespace, not requested by the pod
- **No ServiceAccount token** mounted into preview pods

The namespace is owned by the chart, not created by Helm's
`--create-namespace`, so ArgoCD can prune it. A namespace ArgoCD does not own
leaks one per pull request forever, which was a real defect here once.

## Secrets

| Secret | Where it lives | In git? |
|---|---|---|
| GitHub token for the PR generator | Kubernetes Secret, created at bootstrap | never |
| Per-environment secret salt | Kubernetes Secret, generated once, read back on re-run | never |
| Preview passwords | derived from the salt, never stored | never |
| TLS private keys | cert-manager Secrets | never |
| Session signing key | control plane, generated at first start | never |

Two rules with teeth: the salt is **read back** rather than regenerated when
bootstrap re-runs, because rotating it would silently invalidate every preview
password already posted on an open pull request; and the drift checker reads
Secrets as `PartialObjectMetadata`, so their values never enter its process at
all — a stronger property than promising not to print them.

## What is not secure yet, stated plainly

1. **Every preview is publicly reachable by anyone with the URL.** Private
   previews are implemented but disabled: the cluster has no secret salt, so no
   password can be derived. Until P0-8, treat a preview URL as public.
2. **There is no product authentication**, because there is no product yet. The
   cluster is administered with a kubeconfig.
3. **Webhooks are not verified**, because there are none — GitHub Actions is the
   integration today. This becomes mandatory the moment the GitHub App exists.
4. **The GitHub token in the cluster is a read-only PAT** rather than a
   short-lived installation token. It cannot write, which is why cross-repository
   TTL cleanup currently reports instead of acting (P0-5).

## Responsible disclosure

Security issues should be reported privately to the repository owner rather
than in a public issue. See [`SECURITY.md`](../../SECURITY.md).

No compliance certification is claimed. This platform is not SOC 2, ISO 27001,
HIPAA or GDPR certified, and nothing in this repository should be read as
implying otherwise.
