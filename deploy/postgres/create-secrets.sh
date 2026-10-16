#!/usr/bin/env bash
# Creates the Secrets the Postgres manifests and the chart need and that nothing else creates.
# Run once per namespace, before `kubectl apply -k deploy/postgres`. Needs kubectl and openssl.
#
#   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... deploy/postgres/create-secrets.sh <namespace>
#
# Creates:
#   mira-pg-app-role   basic-auth username/password of the DML-only role mira_app (read by CloudNativePG)
#   mira-db            DATABASE_URL for the same role (read by the chart: secrets.database)
#   mira-pg-backup-s3  object store credentials (read by the ObjectStore)
# It refuses to overwrite an existing Secret. The password goes through files in a private temporary
# directory, never through the command line, and is not printed.
set -euo pipefail

namespace=${1:?usage: create-secrets.sh <namespace>}
cluster=mira-pg
database=mira
role=mira_app
: "${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID}"
: "${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY}"

umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# hex only, so the password needs no URL encoding in DATABASE_URL
openssl rand -hex 24 | tr -d '\n' > "$work/password"
printf '%s' "$role" > "$work/username"
printf 'postgresql://%s:%s@%s-rw:5432/%s' "$role" "$(cat "$work/password")" "$cluster" "$database" > "$work/DATABASE_URL"
printf '%s' "$S3_ACCESS_KEY_ID" > "$work/ACCESS_KEY_ID"
printf '%s' "$S3_SECRET_ACCESS_KEY" > "$work/ACCESS_SECRET_KEY"

kubectl -n "$namespace" create secret generic mira-pg-app-role \
  --type=kubernetes.io/basic-auth \
  --from-file=username="$work/username" --from-file=password="$work/password"
# Password changes in labelled Secrets are applied by the operator immediately.
kubectl -n "$namespace" label secret mira-pg-app-role cnpg.io/reload=true

kubectl -n "$namespace" create secret generic mira-db \
  --from-file=DATABASE_URL="$work/DATABASE_URL"

kubectl -n "$namespace" create secret generic mira-pg-backup-s3 \
  --from-file=ACCESS_KEY_ID="$work/ACCESS_KEY_ID" --from-file=ACCESS_SECRET_KEY="$work/ACCESS_SECRET_KEY"
