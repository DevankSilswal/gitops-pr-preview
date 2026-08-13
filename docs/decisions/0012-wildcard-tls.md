# 0012 — One wildcard certificate, not one per pull request

**Status:** accepted

## Context

Every preview environment requested its own certificate through HTTP-01. That
is the obvious design and it does not survive contact with the arithmetic.

Let's Encrypt allows **50 certificates per registered domain per week**. The
registered domain here was `nip.io` — which is not this operator's domain. It is
shared with everybody else using the service, so the budget is spent by
strangers as well, and the rate limit that eventually stops every preview here
from getting a certificate is not under this project's control at any point.

This is why staging was the default for so long, and why the README carried a
note about browsers showing a warning. That was never a configuration mistake to
be fixed by switching to production; it was the only safe setting given per-host
issuance on a shared domain.

## Decision

One wildcard certificate for `*.<base>` plus the base itself, issued into the
ingress controller's namespace and served for every hostname through
ingress-nginx's `default-ssl-certificate`. Preview environments request nothing:
no `cert-manager.io/cluster-issuer` annotation, no `tls` block, no Certificate
resource.

Three renewals a year against a limit of fifty a week. The limit stops being
reachable rather than being managed.

## Why DNS-01, and why DuckDNS

A wildcard cannot be issued over HTTP-01 — proving control of `*.example.com`
means proving control of its DNS, not of one web server. So DNS-01, which means
the ACME client needs to write a TXT record, which means a domain whose DNS is
controllable by API.

DuckDNS is free, and free is the constraint this whole project is built under
(`docs/cost.md`). The trade is real and worth naming: a dependency on somebody
else's DNS service, and hostnames that say `duckdns.org` — which is more
professional than `nip.io` and less than a real domain.

The swap to a real domain is a change to one solver block. cert-manager has
built-in DNS-01 solvers for Cloudflare, Route53 and others, and nothing above or
below that block knows which is in use.

## Alternatives, and why not

**Keep per-host issuance and hope.** The limit is shared with strangers. Hope is
not a mitigation when the budget is not yours to manage.

**A wildcard secret copied into every namespace** (reflector or similar). Works,
and adds a component to replicate a secret that only ingress-nginx ever reads.
`default-ssl-certificate` needs no copies because the controller terminates TLS,
not the pods.

**Self-signed for previews.** Removes the rate limit and hands every reviewer a
browser warning, which defeats the point of giving them a link.

## Consequences

- Previews create no cert-manager resources at all, so `Certificate` could come
  off the AppProject whitelist. It stays, because per-host issuance remains the
  fallback on a cluster with no wildcard configured.
- The base hostname is now decided at the top of `bootstrap-cluster.sh` rather
  than near the bottom: the certificate and the manifests both need it, and they
  are set up at opposite ends of that script.
- A cluster without `DUCKDNS_TOKEN` keeps the exact behaviour it had — per-host
  HTTP-01 — so this is additive rather than a migration.
- One certificate is one blast radius. If it fails to renew, every environment
  loses TLS at once rather than one at a time. That is a worse tail and a much
  better median, and cert-manager renews at 60 days with 30 to spare.
