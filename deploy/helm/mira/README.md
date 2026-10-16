# MIRA Helm chart

Deploys the MIRA web app (SvelteKit / adapter-node) with a migration Job. Plain Helm, no
subcharts. Postgres is not included. Image and migration details: [docker.md](../../../docs/docker.md),
[migrations.md](../../../docs/migrations.md).

## Prerequisites

1. **A reachable Postgres** with an empty database and a role the app can log in with. Until
   CloudNativePG (S1.10) is in place, any Postgres 15+ works.
2. **Secrets** in the release namespace, created _before_ `helm install` (see below). The chart never
   contains or creates secret values.
3. **An ingress controller.** The defaults target ingress-nginx; set `ingress.className` and
   `ingress.annotations` for anything else, or `ingress.enabled=false` and set `config.origin`.
4. **TLS for the ingress host** (cert-manager annotation, or an existing Secret named by
   `ingress.tls.secretName`).
5. **An OIDC application** registered in PLANTdataHUB (S1.8) for the redirect URI below.
6. **Image access.** The image is `ghcr.io/<owner>/mira:<40-hex commit SHA>` (no `latest`). For a
   private registry create an image pull Secret and pass it as `imagePullSecrets`.

### Create the Secrets

All values below are placeholders.

```sh
kubectl create namespace mira

# App database URL
kubectl -n mira create secret generic mira-db \
  --from-literal=DATABASE_URL='postgres://mira_app:CHANGE_ME@db.example.org:5432/mira'

# Session signing key, at least 32 characters
kubectl -n mira create secret generic mira-auth \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)"

# Optional: OIDC client secret (omit, and leave secrets.oidcClientSecret.name empty, for a public client)
kubectl -n mira create secret generic mira-oidc \
  --from-literal=OIDC_CLIENT_SECRET='CHANGE_ME'

# Optional: a separate DDL-capable role for the migration Job (see "Migrations")
kubectl -n mira create secret generic mira-migrator \
  --from-literal=DATABASE_URL='postgres://mira_migrator:CHANGE_ME@db.example.org:5432/mira'
```

Secret and key names are values (`secrets.*.name` / `.key`), so existing Secrets with other names
work. **CloudNativePG** generates a Secret per role (e.g. `<cluster>-app`) whose keys include `uri`
(a full `postgresql://` URL), `username`, `password` and `host`. Point the chart at it directly:
`--set secrets.database.name=<cluster>-app --set secrets.database.key=uri`. For the split roles of
S1.10 use the migrator role's Secret in `migration.databaseSecret` and the DML-only role's Secret in
`secrets.database`. (Not verified against a real operator: check the key names in your cluster.)

## Install

```sh
helm upgrade --install mira deploy/helm/mira \
  --namespace mira \
  --set image.tag=0123456789abcdef0123456789abcdef01234567 \
  --set ingress.host=mira.example.org \
  --set config.oidc.issuerUrl=https://git.example.org \
  --set config.oidc.clientId=example-client-id \
  --set secrets.database.name=mira-db \
  --set secrets.authSecret.name=mira-auth \
  --set secrets.oidcClientSecret.name=mira-oidc \
  --timeout 10m --wait
```

Or put the same keys in a values file (see [ci/default-values.yaml](ci/default-values.yaml)) and use
`-f`. `image.tag`, `ingress.host` (or `config.origin`), the OIDC issuer and client id, and the secret
references have no defaults: `values.schema.json` rejects the install, naming the missing value.

Use `--set-string` if you pass something that looks like a number as a value.

### OIDC redirect URI

Register this in the PLANTdataHUB (GitLab) application, where `ORIGIN` is `https://<ingress.host>`
unless `config.origin` is set:

```
<ORIGIN>/api/auth/oauth2/callback/oidc
```

`helm install` prints it (and the Secrets it expects) in the release notes; `helm get notes mira -n mira`
shows it again.

## Configuration notes

- **ORIGIN** is derived from `ingress.host` (`https://<host>`); override with `config.origin`.
- **Proxy headers.** adapter-node uses `ORIGIN` when it is set, and then ignores `PROTOCOL_HEADER` and
  `HOST_HEADER`. The chart sets them anyway, and `XFF_DEPTH`, as a safety net. `ADDRESS_HEADER` stays
  unset because the app never reads the client IP. Details are in the `values.yaml` comments.
  ingress-nginx passes `X-Forwarded-Proto/Host` itself, so the ingress needs no extra annotation.
- **Imports are slow.** The ingress sets `proxy-read-timeout`/`proxy-send-timeout` to 300 s because
  Extract/Transform/Load currently run inside one HTTP request. Remove this once S1.11 (background
  worker) lands.
- **Shutdown.** `terminationGracePeriodSeconds` defaults to `preStopSleepSeconds + shutdownTimeout + 10`
  (5 + 30 + 10 = 45 s).
- **Replicas and the database.** Connections = `replicaCount x config.db.poolMax` (+ the Job).
- **PodDisruptionBudget** (`maxUnavailable: 1`) is only rendered when `replicaCount > 1`.
- Config changes roll the pods through a `checksum/config` annotation. Secret changes do not (the chart
  cannot see them): run `kubectl rollout restart deploy/<release>-mira`.

## Migrations

The app never migrates its own database. `templates/migration-job.yaml` is a Helm
`pre-install,pre-upgrade` hook Job that runs `node migrate.js` from the same image, so the schema
matches the code that is about to start. It is deleted when it succeeds and left behind (for
`kubectl logs`) when it fails, in which case `helm upgrade` fails and the running pods are untouched.
Running it in every pod at boot would make all replicas race to apply the same migrations.

**Hook ordering trap.** A pre-install hook runs _before_ the chart's own resources exist. The Job
therefore cannot use anything the chart creates: not the ConfigMap, and not the ServiceAccount. It
uses only the Secrets (which you create first) and a pre-existing ServiceAccount
(`migration.serviceAccountName`, default: the namespace's `default`). Never move the Secrets into the
chart for convenience: the install would then hang or fail on a missing Secret.

`migration.databaseSecret` lets the Job use another role than the app. Use it when the app role has
DML rights only (S1.10): the migrator needs DDL rights, the app does not.

### Rollback

`helm rollback` restores the previous Deployment, but **migrations are forward-only**. Rollback runs
no `pre-upgrade` hook and the runner has no down migrations, so the database keeps the newer schema.
The previous app version has to work with it: write migrations backward compatible (add, then
backfill, then remove one release later). For a destructive migration the only way back is a database
restore. Roll back _the app_ with `helm rollback mira <revision> -n mira`; pin an older `image.tag`
rather than relying on `latest`, which does not exist.

## Values

See [values.yaml](values.yaml) (every value is commented) and [values.schema.json](values.schema.json).

## Not included

- NetworkPolicies and Pod Security admission labels (S2.6)
- Postgres (S1.10, CloudNativePG)
- OIDC application registration (S1.8)
- A background worker Deployment (S1.11)
- Metrics, ServiceMonitor, alerts (S2.8)
- Secret creation, HPA, certificates (cert-manager and the ingress controller are assumed)

## Checks

```sh
helm lint deploy/helm/mira -f deploy/helm/mira/ci/default-values.yaml
helm template mira deploy/helm/mira -f deploy/helm/mira/ci/default-values.yaml | kubeconform -strict -summary -
```

CI runs these for the three value sets in [ci/](ci/).
