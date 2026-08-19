# Registering the GitHub App

Everything here is done once, by a human, in a browser and a terminal. None of
it can be automated from this repository, and none of the values it produces
belong in git.

The control plane refuses to start without all three (`src/config.js` exits
`78`), and refuses to be exposed publicly without the webhook secret. That is
deliberate: an endpoint that can create environments and has no signature to
check is worse than no endpoint.

---

## 1. Create the App

**Settings → Developer settings → GitHub Apps → New GitHub App**

| Field | Value |
|---|---|
| Name | `StackPreview` (or anything unused) |
| Homepage | the repository URL |
| Webhook URL | `https://stackpreview.<base-host>/api/webhooks/github` |
| Webhook secret | generate one — see below |

The base host is the generated value, not a value you choose:

```bash
awk '/^baseHost:/ {print $2}' deploy/platform-chart/values.yaml
```

**Repository permissions** — exactly these, and nothing else:

| Permission | Access | Why |
|---|---|---|
| Pull requests | **Read and write** | the label is the lifecycle API, and the preview comment is written back |
| Contents | **Read** | resolve the head commit an environment is built from |
| Metadata | **Read** | mandatory, granted automatically |

Anything beyond these is a permission an attacker inherits if the private key
leaks. In particular the App needs no access to Actions, Administration,
Secrets, Members or Packages.

**Subscribe to events:**

- `pull_request` — opened, reopened, synchronize, closed
- `installation`
- `installation_repositories`

**Where can this App be installed:** *Only on this account*, unless you intend
to serve repositories you do not control — in which case read
[`security.md`](./security.md) on the fork trust model first.

## 2. Collect the three values

```bash
# App ID — shown on the App's settings page
APP_ID=<the number>

# Private key — "Generate a private key" downloads a .pem. It is shown once.
PRIVATE_KEY=~/Downloads/stackpreview.<date>.private-key.pem

# Webhook secret — generate it, paste it into the App, keep this copy
openssl rand -hex 32
```

## 3. Put them in the cluster, not in git

```bash
kubectl create namespace stackpreview --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic stackpreview-github-app \
  --namespace stackpreview \
  --from-literal=app-id="$APP_ID" \
  --from-literal=webhook-secret="$WEBHOOK_SECRET" \
  --from-file=private-key.pem="$PRIVATE_KEY"
```

This Secret is bootstrap-owned. It is not rendered by the platform chart, not
referenced by any values file, and not recoverable from this repository — if it
is lost, generate a new private key and rotate the webhook secret. The chart
mounts it read-only at mode `0400` and reads the key from a file rather than an
environment variable, because environment variables end up in crash dumps and
`kubectl describe` output.

Verify without printing anything:

```bash
kubectl get secret stackpreview-github-app -n stackpreview \
  -o jsonpath='{range .data}{"keys: "}{end}' \
  && kubectl get secret stackpreview-github-app -n stackpreview -o json \
     | python3 -c 'import sys,json; print(sorted(json.load(sys.stdin)["data"]))'
```

## 4. Install the App on the repositories

**App settings → Install App →** choose the account, then *Only select
repositories* and pick the ones already onboarded in
`deploy/platform/onboarded/`. Installing it on a repository the platform does
not serve does nothing; installing it on one the platform *does* serve, without
that repository being onboarded, also does nothing. Both lists must agree.

## 5. Turn the control plane on

Two separate decisions, in this order, because the second one puts an endpoint
on the internet:

```yaml
# deploy/platform-chart/values.yaml
controlPlane:
  enabled: true            # first: the workload, reachable only inside the cluster
  ingress:
    enabled: true          # second: and only once the Secret above exists
```

Between the two, confirm the process actually started with the configuration it
needs:

```bash
kubectl logs -n stackpreview deploy/stackpreview-control-plane | head -5
kubectl -n stackpreview port-forward deploy/stackpreview-control-plane 8080:8080 &
curl -s localhost:8080/api/health
```

The startup line prints the configuration with the secrets redacted — the
private key as a byte count and the webhook secret as `[set]`. If it prints
`[absent]` for either, the Secret is wrong and the Ingress must stay off.

## 6. Confirm GitHub can reach it

**App settings → Advanced → Recent Deliveries.** A `ping` is delivered when the
webhook URL is first saved; redeliver it and expect `200`. A `401` means the
secret in the cluster and the secret in the App do not match, and no state was
recorded — which is the intended behaviour for an unverified delivery, not a
bug to work around.

---

## What is still not true after all of this

The App can create previews. It cannot yet show them to anyone: there is no
sign-in and no dashboard, so every human endpoint returns `401` by design. The
product surface at this point is the pull request comment and the API.

Private previews remain unavailable until the cluster has a preview secret salt
(P0-8). Until then every preview URL is reachable by anyone who has it, the
product downgrades a `private` policy to `public`, and says so rather than
letting a reviewer assume otherwise.
