# Reaching the dashboard

The dashboard is served by the control plane at the root of its own host. Every
endpoint behind it returns `401` until there is a session, and there are two
ways to get one.

## The intended way: sign in with GitHub

This needs an **OAuth App**, which is not the same thing as the GitHub App that
talks to repositories. They answer different questions — one says who is looking
at the dashboard, the other says what the platform may do to a repository — and
reusing the second for the first would hand every visitor the platform's own
permissions.

**Settings → Developer settings → OAuth Apps → New OAuth App**

| Field | Value |
|---|---|
| Application name | StackPreview |
| Homepage URL | `https://stackpreview.<base-host>` |
| Authorization callback URL | `https://stackpreview.<base-host>/auth/github/callback` |

The base host is generated, not chosen:

```bash
awk '/^baseHost:/ {print $2}' deploy/platform-chart/values.yaml
```

Then put the two values in the cluster, next to the credentials that are already
there:

```bash
kubectl create secret generic stackpreview-github-app -n stackpreview \
  --from-literal=token="$EXISTING_TOKEN" \
  --from-literal=webhook-secret="$EXISTING_WEBHOOK_SECRET" \
  --from-literal=oauth-client-id="$CLIENT_ID" \
  --from-literal=oauth-client-secret="$CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -
```

The control plane logs a warning at startup when these are absent and
`/auth/github` answers `501` with the reason rather than failing obscurely.

Only `read:user` is requested. The access token is used once, server-side, to
learn who signed in, and then discarded — the browser only ever receives a
session id.

## Before that exists: grant access from the cluster

OAuth creates a user row on first sign-in. It cannot create a **membership**,
because there is no safe answer to "what role should a stranger have", so the
first one is always granted by somebody with access to the cluster:

```bash
kubectl exec -n stackpreview deploy/stackpreview-control-plane -- \
  node /app/scripts/grant-access.js <github-login> owner
```

That also prints a one-hour session for reaching the dashboard before an OAuth
App is registered. It is the same signed, revocable, `HttpOnly` session the
OAuth flow produces — the difference is only how it was obtained.

## Roles

| | Owner | Admin | Developer | Viewer |
|---|---|---|---|---|
| See previews and status | ✓ | ✓ | ✓ | ✓ |
| Open a preview URL | ✓ | ✓ | ✓ | ✓ |
| Read logs | ✓ | ✓ | ✓ | — |
| Redeploy, roll back, destroy | ✓ | ✓ | ✓ | — |
| Pin an environment | ✓ | ✓ | — | — |
| Connect repositories, edit policy | ✓ | ✓ | — | — |
| Manage members | ✓ | — | — | — |

A viewer can use a running preview and cannot read its logs. That is deliberate:
application logs contain whatever the application logged, and being allowed to
click a link is a weaker thing to be trusted with.

The dashboard hides what a role cannot do. That is a courtesy — every one of
these is enforced again on the server, and the tests assert it by calling the
API directly with each role.
