# MIRA Helm chart

Deploys the MIRA web app (SvelteKit / adapter-node), an ETL worker and a migration Job. Plain Helm, no
subcharts. Postgres is not included. Image and migration details: [docker.md](../../../docs/docker.md),
[migrations.md](../../../docs/migrations.md).

## Prerequisites

1. **A reachable Postgres** with an empty database and a role the app can log in with. Any Postgres 15+
   works; the intended setup is CloudNativePG ([deploy/postgres](../../postgres/README.md), see
   [With CloudNativePG](#with-cloudnativepg)).
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
work.

**CloudNativePG** generates one Secret for the database owner, `<cluster>-app`. Its keys (read from the operator source,
`pkg/specs/secrets.go`, v1.30.1; not checked against a running operator) are: `username`, `user`, `password`, `dbname`,
`host`, `port`, `pgpass`, `uri`, `jdbc-uri`, `fqdn-uri`, `fqdn-jdbc-uri`. `uri` is a complete `postgresql://` URL, so it can be used
as `DATABASE_URL` directly. Roles added through `managed.roles` get **no** generated Secret (you supply a
`basic-auth` Secret with `username` and `password` only), so the DML-only role's URL has to be assembled
by hand: `deploy/postgres/create-secrets.sh` does it. The pairing used by the manifests:

| Chart value                | Secret        | Key            | Role            |
| -------------------------- | ------------- | -------------- | --------------- |
| `migration.databaseSecret` | `mira-pg-app` | `uri`          | `mira_migrator` |
| `secrets.database`         | `mira-db`     | `DATABASE_URL` | `mira_app`      |
| `config.db.caSecret`       | `mira-pg-ca`  | `ca.crt`       | (server CA)     |

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

### With CloudNativePG

After [deploy/postgres](../../postgres/README.md) is applied and healthy, add these to the install command
(or a values file, see [ci/cnpg-values.yaml](ci/cnpg-values.yaml)):

```sh
  --set secrets.database.name=mira-db \
  --set migration.databaseSecret.name=mira-pg-app --set migration.databaseSecret.key=uri \
  --set config.db.ssl=verify-full \
  --set config.db.caSecret.name=mira-pg-ca
```

- `config.db.caSecret` mounts only the Secret's `ca.crt` (read-only, `/etc/mira/db-ca`) and sets
  `NODE_EXTRA_CA_CERTS` in the web, worker and migration pods. The Secret must exist before the install, because the
  migration Job is a pre-install hook. `extraEnv` cannot do this: it has no volume and does not reach the Job.
- `NODE_EXTRA_CA_CERTS` is read once at process start: after the CA is replaced, restart the pods.
- The `DATABASE_URL` host must be a name in the server certificate, e.g. `mira-pg-rw`; the operator-generated `uri`
  uses `mira-pg-rw.<namespace>`, which is also in it.
- `config.db.prepare=false` (`DB_PREPARE`) is only for a PgBouncer older than 1.21 or with `max_prepared_statements=0`.
  It does not reach the migration Job, which must connect to the database directly, never through a pooler.
- Connections: `replicaCount x poolMax` plus the worker's `poolMax`; the budget is in
  [docs/infrastructure.md](../../../docs/infrastructure.md).
- Not verified against a real cluster: that a Secret mounted with `items` works with the operator-issued CA, and the
  TLS handshake against a real CloudNativePG certificate.

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
- **Imports run in the worker**, not in the HTTP request (S1.11), so the ingress needs no raised
  timeouts: ingress-nginx's default 60 s is plenty. See [Worker](#worker).
- **Shutdown.** `terminationGracePeriodSeconds` defaults to `preStopSleepSeconds + shutdownTimeout + 10`
  (5 + 30 + 10 = 45 s).
- **Replicas and the database.** Connections = `replicaCount x config.db.poolMax` (+ the Job).
- **PodDisruptionBudget** (`maxUnavailable: 1`) is only rendered when `replicaCount > 1`.
- Config changes roll the pods through a `checksum/config` annotation. Secret changes do not (the chart
  cannot see them): run `kubectl rollout restart deploy/<release>-mira`.

## Worker

`templates/worker-deployment.yaml` runs the same image with `command: ["node", "worker.js"]`. The
Extract/Transform/Load actions on the ARC page only queue a job (table `etl_job`); the worker claims
and runs it. Design, failure modes and job states: [docs/etl-worker.md](../../../docs/etl-worker.md).

- **Needs** the same Secrets and config as the web app: it refreshes the importing user's PLANTdataHUB
  token through better-auth (`BETTER_AUTH_SECRET`, `OIDC_*`), and writes to the database with the app
  role (DML only is enough; the queue table is created by the migration Job).
- **No Service, Ingress or probes.** It serves no HTTP, and an exec/file liveness check would say
  nothing about whether imports work. Instead the worker exits non-zero when the database stays
  unreachable (10 failed polls in a row), and the kubelet restarts it. A hung import is not killed by
  a probe: every outbound request has a timeout and a job whose worker stops renewing its lease is
  reclaimed by another worker.
- **Values** (`worker.*`): `enabled`, `replicas` (default 1), `concurrency` (jobs per pod, default 1,
  keep `config.db.poolMax` >= concurrency + 2), `leaseSeconds`, `pollSeconds`, `shutdownTimeoutSeconds`,
  `resources`. Shared with the web app (`config.*`): `http.headersTimeout`/`http.timeout` (outbound
  request limits) and `etl.maxAttempts`/`etl.retryDelaySeconds`.
- **Shutdown.** `terminationGracePeriodSeconds` defaults to `shutdownTimeoutSeconds + 15` (60 + 15 =
  75 s). On SIGTERM the worker stops claiming, waits that long for the running job, hands an unfinished
  job back to the queue (another worker re-runs it from the start) and exits 0.
- **Rollouts.** `maxSurge: 1, maxUnavailable: 0`, and the migration hook runs before any worker is
  replaced. A job running on the old worker is handed back on SIGTERM, or reclaimed when its lease
  (`leaseSeconds`) expires if the pod was killed.
- A **PodDisruptionBudget** for the worker is rendered only when `worker.replicas > 1`.
- `worker.enabled=false` leaves queued jobs untouched until a worker runs somewhere.

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

## Monitoring and retention

Details, the metric list and the alert table: [docs/observability.md](../../../docs/observability.md).

- **`/metrics`** exists only when `secrets.metricsToken.name` names a Secret with `METRICS_TOKEN` (at least 32
  characters); the web pods read it. Without it the endpoint answers 404.
- **`monitoring.serviceMonitor.enabled`** and **`monitoring.prometheusRule.enabled`** (both `false` by default: they
  need the Prometheus operator CRDs). The ServiceMonitor needs the token Secret; the schema refuses it otherwise. Set
  `monitoring.*.labels` to whatever your Prometheus selects by (`release: kube-prometheus-stack`, for instance). The
  rules include the Postgres backup, archiving and connection alerts (`monitoring.prometheusRule.postgres.*`).
- **`retention.*`** renders a CronJob `<release>-mira-retention` (default on, 90 days, daily 03:17 UTC) that runs
  `node retention.js` with `secrets.database` (the DML-only role), batched. `retention.days` must be at least 30.
- Example values: [ci/monitoring-values.yaml](ci/monitoring-values.yaml); the rule tests: [ci/rules-test.yaml](ci/rules-test.yaml).

## Network policies, Pod Security and edge settings (S2.6, S2.7)

Full pages: [network-policy.md](../../../docs/network-policy.md), [security-headers.md](../../../docs/security-headers.md), [rate-limits.md](../../../docs/rate-limits.md).

- **`networkPolicy.enabled`** (default `false`): default deny for the release's pods, then per kind only what it needs (web: ingress from the ingress controller and Prometheus, egress to Postgres, PLANTdataHUB and DNS; worker: also NCBI; migration Job and retention CronJob: Postgres and DNS).
  Egress to the two hosts needs addresses: `networkPolicy.egress.mode` is `cidr` (default; the chart refuses to render without `egress.plantdatahub.cidrs`), `cilium` (host names, needs Cilium) or `https` (any public HTTPS address). Check the namespace values (`ingressController.namespace`, `prometheus.namespace`, `dns.*`, `postgres.*`) before turning it on: a wrong ingress namespace makes the site unreachable. Needs a network plugin that enforces NetworkPolicy.
- **Pod Security.** All pods meet the `restricted` profile (asserted in CI). The chart does not create the namespace, so label it:
  `kubectl label namespace <ns> pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted pod-security.kubernetes.io/audit=restricted`.
- **`security.csp.mode`** (`report-only` default, `enforce`, `off`) and **`security.hsts.maxAge`** (seconds, default 15552000, 0 = off) reach the app as `CSP_MODE` and `HSTS_MAX_AGE`.
- **`ingress.rateLimit.*`** (default off): ingress-nginx annotations, 20 requests/s per address with a burst of 5x. Over the limit nginx answers 503 unless its ConfigMap sets `limit-req-status-code: "429"`.
- **`config.proxy.xffDepth`** (default 1) is also how many proxies append to `X-Forwarded-For` for the sign-in rate limit: set it to the real number.
- Example values: [ci/network-policy-values.yaml](ci/network-policy-values.yaml), [ci/network-policy-cilium-values.yaml](ci/network-policy-cilium-values.yaml), [ci/network-policy-https-values.yaml](ci/network-policy-https-values.yaml), [ci/rate-limit-values.yaml](ci/rate-limit-values.yaml). The assertions: [ci/check-rendered.mjs](ci/check-rendered.mjs).

## Values

See [values.yaml](values.yaml) (every value is commented) and [values.schema.json](values.schema.json).

## Not included

- The namespace and its Pod Security labels (see above), and a network plugin
- Postgres itself: manifests are in [deploy/postgres](../../postgres/README.md), not part of this chart
- OIDC application registration: [docs/oidc-setup.md](../../../docs/oidc-setup.md)
- Prometheus itself, Alertmanager and a log shipper (the chart renders a ServiceMonitor and a PrometheusRule behind flags, see [Monitoring](#monitoring-and-retention))
- Secret creation, HPA, certificates (cert-manager and the ingress controller are assumed)

## Checks

```sh
helm lint deploy/helm/mira -f deploy/helm/mira/ci/default-values.yaml
helm template mira deploy/helm/mira -f deploy/helm/mira/ci/default-values.yaml | kubeconform -strict -summary -
```

CI runs these for the eleven value sets in [ci/](ci/) (default, single replica, no ingress, worker
disabled, scaled worker, CloudNativePG, monitoring, network policies in three egress modes, ingress rate limit), checks that the monitoring objects are absent by
default and present with the flags, runs `promtool check rules` and `promtool test rules` on the rendered alert rules,
asserts the Pod Security and network policy fields of every pod kind (`ci/check-rendered.mjs`), and checks that a bad `worker.*`, `config.db.ssl`, `retention.days`, `security.csp.mode`, a ServiceMonitor without a token, or network policies without PLANTdataHUB addresses is rejected.
