#!/usr/bin/env bash
# Renders deploy/postgres with kustomize (plus the optional pooler and the restore example) and validates it with kubeconform against the CRD schemas of the
# PINNED operator and plugin versions. Offline except for downloading those release manifests.
# Needs docker, curl, python3 with PyYAML. Run from the repository root:  deploy/postgres/validate.sh
#
# What this checks: the manifests render, and every field exists in the CRDs with a plausible type.
# What it cannot check: that the operator accepts the values, that names resolve, that Secrets exist.
set -euo pipefail

CNPG_VERSION=1.30.1
CNPG_SHA256=37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb
BARMAN_VERSION=0.15.1
BARMAN_SHA256=8f377ff4a7d0d3f74fc64b0f7ac4f449fc38ca9e83a40107cca2f9315a9bd920
KUSTOMIZE_IMAGE=registry.k8s.io/kustomize/kustomize:v5.4.3
KUBECONFORM_IMAGE=ghcr.io/yannh/kubeconform:v0.6.7

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'kill "${server:-}" 2>/dev/null || true; rm -rf "$work"' EXIT

fetch() { # url sha256 file
  curl -fsSL --max-time 120 -o "$work/$3" "$1"
  echo "$2  $work/$3" | sha256sum -c --quiet - || { echo "checksum mismatch for $1" >&2; exit 1; }
}
fetch "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${CNPG_VERSION}/cnpg-${CNPG_VERSION}.yaml" "$CNPG_SHA256" cnpg.yaml
fetch "https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v${BARMAN_VERSION}/manifest.yaml" "$BARMAN_SHA256" barman.yaml
python3 -I "$here/hack/crd-to-jsonschema.py" "$work/schemas" "$work/cnpg.yaml" "$work/barman.yaml"

# Render. Bind mounts are not available everywhere, so stream the directory in as a tar.
tar -C "$here" -c . | docker run --rm -i --entrypoint sh "$KUSTOMIZE_IMAGE" -c \
  'mkdir /w && tar -x -C /w && kustomize build /w' > "$work/rendered.yaml"
{ cat "$work/rendered.yaml"; for f in optional/pooler.yaml restore/cluster-restore.yaml; do echo '---'; cat "$here/$f"; done; } > "$work/all.yaml"

port=$((20000 + RANDOM % 20000))
(cd "$work/schemas" && exec python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) &
server=$!
sleep 1
docker run --rm -i --network host "$KUBECONFORM_IMAGE" -strict -summary \
  -schema-location default \
  -schema-location "http://127.0.0.1:${port}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  - < "$work/all.yaml"
