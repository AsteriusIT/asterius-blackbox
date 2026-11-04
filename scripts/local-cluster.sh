#!/usr/bin/env bash
# Local Kubernetes for Blackbox previews: a kind cluster with ingress-nginx published on the host.
#
#   scripts/local-cluster.sh up      # create the cluster (idempotent) and print the .env settings
#   scripts/local-cluster.sh down    # delete it
#   scripts/local-cluster.sh env     # print the .env settings again
#
# Previews are then reachable at http://<app>-<env>.localtest.me[:PORT]  (*.localtest.me resolves to 127.0.0.1).
# Images are built with your local Docker and loaded into the cluster with `kind load` — no registry needed.
#
# Variables: CLUSTER_NAME (blackbox), HTTP_PORT (80), HTTPS_PORT (443), KUBECONFIG_FILE (data/kubeconfig-local)
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-blackbox}"
HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KUBECONFIG_FILE="${KUBECONFIG_FILE:-$ROOT/data/kubeconfig-local}"
INGRESS_MANIFEST="https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml"

need() { command -v "$1" >/dev/null || { echo "✗ $1 is required ($2)" >&2; exit 1; }; }

print_env() {
  local port_suffix=""
  [ "$HTTP_PORT" != "80" ] && port_suffix="$HTTP_PORT"
  cat <<ENV

# ---- add to .env (local Kubernetes previews) ----
K8S_ENABLED=true
KUBECONFIG_PATH=$KUBECONFIG_FILE
K8S_BUILD_MODE=docker
K8S_IMAGE_LOAD=kind
K8S_LOCAL_CLUSTER_NAME=$CLUSTER_NAME
K8S_IMAGE_REGISTRY=blackbox.local
K8S_BASE_DOMAIN=localtest.me
K8S_INGRESS_CLASS=nginx
K8S_INGRESS_NAMESPACE=ingress-nginx
K8S_PUBLIC_PORT=$port_suffix
ENV
}

up() {
  need docker "https://docs.docker.com/get-docker/"
  need kind "go install sigs.k8s.io/kind@latest  or  https://kind.sigs.k8s.io"
  need kubectl "https://kubernetes.io/docs/tasks/tools/"
  mkdir -p "$(dirname "$KUBECONFIG_FILE")"

  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    echo "✓ kind cluster '$CLUSTER_NAME' already exists"
    kind export kubeconfig --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG_FILE" >/dev/null
  else
    echo "→ creating kind cluster '$CLUSTER_NAME' (ingress on host ports $HTTP_PORT/$HTTPS_PORT)"
    cat <<KIND | kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG_FILE" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - { containerPort: 80, hostPort: $HTTP_PORT, protocol: TCP }
      - { containerPort: 443, hostPort: $HTTPS_PORT, protocol: TCP }
KIND
  fi

  export KUBECONFIG="$KUBECONFIG_FILE"
  if ! kubectl get ns ingress-nginx >/dev/null 2>&1; then
    echo "→ installing ingress-nginx"
    kubectl apply -f "$INGRESS_MANIFEST" >/dev/null
  fi
  echo "→ waiting for the ingress controller"
  kubectl -n ingress-nginx wait --for=condition=available deploy/ingress-nginx-controller --timeout=240s >/dev/null
  # "available" is not enough: the admission webhook may still refuse connections for a few seconds.
  for i in $(seq 1 60); do
    if kubectl create ingress blackbox-probe --rule="probe.localtest.me/*=probe:80" --dry-run=server -n default >/dev/null 2>&1; then break; fi
    [ "$i" = 60 ] && { echo "✗ ingress admission webhook not ready" >&2; exit 1; }
    sleep 2
  done
  # The dev server uses this kubeconfig directly; it only needs the build namespace (RBAC lives in the Helm chart).
  kubectl create namespace blackbox-builds --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "✓ local cluster ready (kubeconfig: $KUBECONFIG_FILE — your default kubeconfig is untouched)"
  print_env
}

down() {
  need kind "https://kind.sigs.k8s.io"
  kind delete cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG_FILE"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  env) print_env ;;
  *) echo "usage: $0 up|down|env" >&2; exit 2 ;;
esac
