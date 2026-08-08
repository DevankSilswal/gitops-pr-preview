#!/usr/bin/env bash
#
# One-shot cluster setup. Run once against a fresh cluster, with KUBECONFIG
# already pointing at it.
#
#   export GITHUB_TOKEN=github_pat_...
#   ./scripts/bootstrap-cluster.sh <node-public-ip>
#
# Which repositories get preview environments is not an argument, and not
# something this script decides: ArgoCD reads deploy/platform/onboarded/ from
# git. Onboarding one is a commit, not another run of this.
#
# Optional:
#   ACME_EMAIL=you@example.com     also install cert-manager and TLS issuers
#   WITH_OBSERVABILITY=1           also install Prometheus and Grafana
#
# Installs the platform, gives ArgoCD a token to read pull requests, then
# applies the ApplicationSet. Nothing here runs again afterwards: opening a
# pull request is the only action needed to create an environment.

set -euo pipefail

NODE_IP="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$NODE_IP" ]]; then
  echo "usage: $0 <node-public-ip>" >&2
  exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN is not set." >&2
  echo "Create a fine-grained PAT with read access to Contents and Pull requests." >&2
  exit 1
fi

echo "==> Checking cluster connectivity"
kubectl cluster-info >/dev/null

# The base hostname every preview URL hangs off, decided here because both the
# certificate and the manifests need it and they are set up at opposite ends of
# this script.
#
# With a DuckDNS domain, that domain. Without one, nip.io derived from the node
# address — and in dash form, because nip.io splits on dashes as well as dots
# when it looks for an address, so a dotted IP after a label like `pr-1` is
# misread: pr-1.127.0.0.1.nip.io resolves to 1.127.0.0.
if [[ -n "${DUCKDNS_DOMAIN:-}" ]]; then
  PREVIEW_BASE_HOST="$DUCKDNS_DOMAIN"
else
  PREVIEW_BASE_HOST="$(echo "$NODE_IP" | tr '.' '-').nip.io"
fi
echo "    preview hostnames will be <slug>-pr-<number>.$PREVIEW_BASE_HOST"

echo "==> Installing ingress-nginx"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null

if [[ -n "${DEV_CLUSTER:-}" ]]; then
  # kind has no load balancer implementation, so the controller binds the
  # node's ports directly. scripts/kind-cluster.yaml maps those to the host,
  # which makes nip.io hostnames resolve exactly as they do in production.
  # Each element is quoted whole. Unquoted, `key[0]=value` inside an array
  # literal reads as an indexed assignment rather than as one argument — SC2191,
  # and genuinely ambiguous to anyone reading it. These are helm arguments, not
  # array indices.
  INGRESS_ARGS=(
    --set 'controller.hostPort.enabled=true'
    --set 'controller.service.type=NodePort'
    # nodeSelector values are strings in the Kubernetes API. Plain --set sends
    # a bare true, which the API server rejects as a type error.
    --set-string 'controller.nodeSelector.ingress-ready=true'
    --set-string 'controller.tolerations[0].key=node-role.kubernetes.io/control-plane'
    --set-string 'controller.tolerations[0].operator=Exists'
    --set-string 'controller.tolerations[0].effect=NoSchedule'
  )
else
  INGRESS_ARGS=(--set 'controller.service.type=LoadBalancer')
fi

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  "${INGRESS_ARGS[@]}" \
  --set controller.ingressClassResource.default=true \
  --set controller.config.global-allowed-response-headers=X-Robots-Tag \
  --wait --timeout 10m

if [[ -n "${ACME_EMAIL:-}" || -n "${WITH_TLS:-}" ]]; then
  echo "==> Installing cert-manager"
  helm upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager --create-namespace \
    --set crds.enabled=true \
    --wait --timeout 10m

  # Needs no account, so it is always available — including on clusters the
  # ACME servers cannot reach.
  echo "==> Creating the self-signed issuer"
  kubectl apply -f "$REPO_ROOT/deploy/platform/issuer-selfsigned.yaml"

  if [[ -n "${ACME_EMAIL:-}" ]]; then
    echo "==> Creating Let's Encrypt issuers"
    sed "s|__ACME_EMAIL__|$ACME_EMAIL|g" \
      "$REPO_ROOT/deploy/platform/cluster-issuers.yaml" | kubectl apply -f -
  else
    echo "==> Skipping Let's Encrypt issuers (set ACME_EMAIL to create them)"
  fi

  # One certificate for every hostname this cluster will ever serve, instead of
  # one per pull request. See deploy/platform/wildcard-tls.yaml for why that
  # matters more than it sounds: the per-host path spends a rate limit that is
  # shared with every other user of the same registered domain.
  if [[ -n "${DUCKDNS_TOKEN:-}" && -n "${ACME_EMAIL:-}" ]]; then
    echo "==> Installing the DuckDNS DNS-01 solver"
    helm repo add duckdns https://ebrianne.github.io/helm-charts >/dev/null 2>&1 || true
    helm repo update >/dev/null
    helm upgrade --install cert-manager-webhook-duckdns duckdns/cert-manager-webhook-duckdns \
      --namespace cert-manager \
      --set duckdns.token="$DUCKDNS_TOKEN" \
      --set clusterIssuer.production.create=false \
      --set clusterIssuer.staging.create=false \
      --wait --timeout 5m

    # The solver reads the token from a secret in its own namespace; the chart
    # above creates one, and this makes the name match what the issuer asks for
    # regardless of what the chart called it.
    kubectl -n cert-manager create secret generic duckdns-token \
      --from-literal=token="$DUCKDNS_TOKEN" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null

    echo "==> Requesting the wildcard certificate for *.$PREVIEW_BASE_HOST"
    sed -e "s|__ACME_EMAIL__|$ACME_EMAIL|g" \
        -e "s|__PREVIEW_BASE_HOST__|$PREVIEW_BASE_HOST|g" \
      "$REPO_ROOT/deploy/platform/wildcard-tls.yaml" | kubectl apply -f -

    # Serve it for any host that does not bring its own certificate — which,
    # once the wildcard exists, is every preview environment.
    echo "==> Pointing ingress-nginx at the wildcard"
    helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
      --namespace ingress-nginx --reuse-values \
      --set controller.extraArgs.default-ssl-certificate=ingress-nginx/preview-wildcard-tls \
      --wait --timeout 10m

    WILDCARD_TLS=true
    echo "    a wildcard covers every preview; none will request its own"
  else
    WILDCARD_TLS=false
    [[ -n "${ACME_EMAIL:-}" ]] && \
      echo "==> No DUCKDNS_TOKEN — falling back to a certificate per hostname"
  fi
else
  echo "==> Skipping cert-manager (set ACME_EMAIL, or WITH_TLS for self-signed)"
fi

if [[ -n "${WITH_OBSERVABILITY:-}" ]]; then
  # Two shapes, because one of them does not fit on a small node.
  #
  # `full` is kube-prometheus-stack: operator, CRDs, Grafana, dashboards.
  # It was tried twice on this 2-vCPU node and took it down both times —
  # load past 9, API server unresponsive, preview URLs dead. Four vCPU or
  # a node of its own.
  #
  # `lite` is Prometheus with kube-state-metrics and node-exporter, no
  # operator and no Grafana. The same alerts, read in Prometheus's own UI.
  if [[ "${WITH_OBSERVABILITY}" == "full" ]]; then
    echo "==> Installing Prometheus and Grafana (needs four vCPU)"
    helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
      --namespace monitoring --create-namespace \
      --values "$REPO_ROOT/deploy/platform/observability/values.yaml" \
      --wait --timeout 15m
    kubectl apply -f "$REPO_ROOT/deploy/platform/observability/dashboard.yaml"
    kubectl apply -f "$REPO_ROOT/deploy/platform/observability/alerts.yaml"
  else
    echo "==> Installing Prometheus (no operator, no Grafana)"
    # The alerts live in a PrometheusRule, which is the operator's format.
    # Without the operator they have to be handed over as a plain rules
    # file — extracted from the same source rather than written twice.
    RULES="$(mktemp)"
    trap 'rm -f "$RULES"' EXIT
    ruby -ryaml -e '
      doc = YAML.safe_load(File.read(ARGV[0]))
      print({ "serverFiles" => { "alerting_rules.yml" =>
        { "groups" => doc.fetch("spec").fetch("groups") } } }.to_yaml)
    ' "$REPO_ROOT/deploy/platform/observability/alerts.yaml" > "$RULES"

    helm upgrade --install monitoring prometheus-community/prometheus \
      --namespace monitoring --create-namespace \
      --values "$REPO_ROOT/deploy/platform/observability/values-lite.yaml" \
      --values "$RULES" \
      --wait --timeout 12m
  fi
else
  echo "==> Skipping observability (WITH_OBSERVABILITY=1 for lite, =full for Grafana)"
fi

echo "==> Installing ArgoCD"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
# Server-side apply is required, not a preference: ArgoCD's CRDs are larger
# than the 262144-byte ceiling on the last-applied-configuration annotation
# that client-side apply writes, so a plain `kubectl apply` fails outright on
# applicationsets.argoproj.io.
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

echo "==> Waiting for ArgoCD to come up"
kubectl wait --for=condition=available --timeout=10m \
  deployment/argocd-server deployment/argocd-applicationset-controller -n argocd

# Lets GitHub notify ArgoCD instead of ArgoCD asking every minute. The endpoint
# verifies this signature, which is what makes exposing it safe.
if [[ -n "${WEBHOOK_SECRET:-}" ]]; then
  echo "==> Storing the webhook signing secret"
  kubectl -n argocd patch secret argocd-secret \
    --type merge \
    -p "{\"stringData\":{\"webhook.github.secret\":\"${WEBHOOK_SECRET}\"}}" >/dev/null
else
  echo "==> No WEBHOOK_SECRET set — GitHub pushes will be rejected, polling still works"
fi

# The ApplicationSet controller builds its webhook handler at startup, and
# needs server.secretkey to do it — which argocd-server generates on first run.
# On a fresh cluster the controller loses that race, logs
# "server.secretkey is missing", and then runs indefinitely with nothing bound
# to the port its own Service advertises. Restarting it once the key exists is
# the whole fix, and finding that out took an hour of 502s.
if [[ -n "${WEBHOOK_SECRET:-}" ]]; then
  echo "==> Restarting the ApplicationSet controller so it binds its webhook"
  kubectl -n argocd rollout restart deploy/argocd-applicationset-controller >/dev/null
  kubectl -n argocd rollout status deploy/argocd-applicationset-controller --timeout=5m >/dev/null
fi

# Cluster-wide secret material, from which every per-environment secret — the
# preview password, the ephemeral database password — is derived.
#
# Read back if it already exists rather than regenerated, because rotating it
# would silently invalidate every preview password already posted on an open
# pull request. Re-running this script has to stay safe, which is a property
# that has been verified four times over and is easy to break here.
echo "==> Ensuring the per-environment secret salt exists"
PREVIEW_SECRET_SALT="$(kubectl -n argocd get secret preview-secret-salt \
  -o jsonpath='{.data.salt}' 2>/dev/null | base64 -d 2>/dev/null || true)"

if [[ -z "$PREVIEW_SECRET_SALT" ]]; then
  # openssl is present on any machine that got this far; head -c on
  # /dev/urandom would do as well.
  PREVIEW_SECRET_SALT="$(openssl rand -hex 32)"
  kubectl create secret generic preview-secret-salt \
    --namespace argocd \
    --from-literal=salt="$PREVIEW_SECRET_SALT" >/dev/null
  echo "    generated a new salt"
else
  echo "    reusing the existing salt, so passwords already posted stay valid"
fi
export PREVIEW_SECRET_SALT

echo "==> Storing the GitHub token for the pull request generator"
kubectl create secret generic github-token \
  --namespace argocd \
  --from-literal=token="$GITHUB_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> Applying ArgoCD manifests for node=$NODE_IP"

# Preview environments get certificates only if an issuer exists to sign them.
if [[ -n "${ACME_EMAIL:-}" ]]; then
  TLS_ENABLED=true
  # Staging certificates are not trusted by browsers, so anyone opening a
  # preview link gets a security warning — which defeats the point of handing
  # the link to a reviewer. Production is the default; set ACME_STAGING=1 while
  # iterating on the ACME setup itself, where the rate limit matters more than
  # the padlock.
  if [[ -n "${ACME_STAGING:-}" ]]; then
    TLS_ISSUER=letsencrypt-staging
  else
    TLS_ISSUER=letsencrypt-prod
  fi
elif [[ -n "${WITH_TLS:-}" ]]; then
  TLS_ENABLED=true
  TLS_ISSUER=selfsigned
else
  TLS_ENABLED=false
  TLS_ISSUER=selfsigned
fi

# Nothing about which repositories are served is baked in here: ArgoCD reads
# deploy/platform/onboarded/ from git itself, so this script never has to run
# again to onboard one. It only fills in what is true of the cluster — the base
# hostname and the TLS issuer — and validates the onboarded files on the way
# past, since a malformed one would otherwise show up as an environment that
# never appears.
export PREVIEW_BASE_HOST TLS_ENABLED TLS_ISSUER
# Set above, where the wildcard is requested. Tells the chart not to ask for a
# certificate of its own.
export TLS_WILDCARD="${WILDCARD_TLS:-false}"
export PROD_IMAGE_TAG=latest
# PREVIEW_SECRET_SALT is already exported above, where it is generated or read
# back; render-argocd.rb substitutes it into the ApplicationSet.

# Applied in a stated order rather than whatever the glob happens to produce.
# The project has to exist before anything references it — and alphabetically
# the ApplicationSet, which is the whole point of this script, came last. One
# failure earlier in the glob took the script down with it and left the cluster
# running the previous ApplicationSet, looking for all the world like the new
# one had been applied.
MANIFESTS=(
  appproject-previews.yaml   # referenced by the ApplicationSet below
  applicationset-preview.yaml
  application-prod.yaml
  webhook-ingress.yaml       # lets GitHub push changes instead of ArgoCD polling
)

for name in "${MANIFESTS[@]}"; do
  echo "  applying $name"
  "$REPO_ROOT/scripts/render-argocd.rb" "$REPO_ROOT/deploy/argocd/$name" | kubectl apply -f -
done

# Anything added to deploy/argocd/ and not listed above would be silently
# skipped, which is the same class of mistake in the other direction.
for manifest in "$REPO_ROOT"/deploy/argocd/*.yaml; do
  name="$(basename "$manifest")"
  # shellcheck disable=SC2076
  if [[ ! " ${MANIFESTS[*]} " =~ " $name " ]]; then
    echo "error: $name is in deploy/argocd/ but not in the apply order" >&2
    exit 1
  fi
done

cat <<EOF

Done.
  ArgoCD UI:       kubectl port-forward svc/argocd-server -n argocd 8080:443
  Admin password:  kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
  Preview URLs:    https://<slug>-pr-<number>.$PREVIEW_BASE_HOST

Set PREVIEW_BASE_HOST to '$PREVIEW_BASE_HOST' in the repository variables so CI
can post preview links on pull requests:
  gh variable set PREVIEW_BASE_HOST --body '$PREVIEW_BASE_HOST'

Preview environments are password-protected. CI derives each password from the
cluster salt, so it needs the same value to post it on the pull request:
  gh secret set PREVIEW_SECRET_SALT --body "\$(kubectl -n argocd get secret \\
    preview-secret-salt -o jsonpath='{.data.salt}' | base64 -d)"

Label a pull request 'preview' to create your first environment.
EOF
