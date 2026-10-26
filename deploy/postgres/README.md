# Postgres for MIRA (CloudNativePG)

Manifests for S1.10. Decisions and their failure modes: [docs/infrastructure.md](../../docs/infrastructure.md).
Backup, restore drill and rollback: [docs/postgres-runbook.md](../../docs/postgres-runbook.md).

**Status: drafted, never applied to a cluster.** The files render and pass `kubeconform -strict`
against the pinned CRDs (`validate.sh`). The role SQL was run against a local Postgres 17. Everything
below that needs a cluster is for a human to tick off on staging.

| File                                                         | What                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [kustomization.yaml](kustomization.yaml)                     | Base: ObjectStore, Cluster, ScheduledBackup, and the role SQL as a ConfigMap               |
| [cluster.yaml](cluster.yaml)                                 | 3-instance `Cluster` `mira-pg`, database `mira`, owner `mira_migrator`, managed `mira_app` |
| [sql/roles.sql](sql/roles.sql)                               | `mira_dml` group role, grants and default privileges (run once at bootstrap)               |
| [objectstore.yaml](objectstore.yaml)                         | Barman Cloud `ObjectStore` (placeholder endpoint and bucket), 30-day retention             |
| [scheduled-backup.yaml](scheduled-backup.yaml)               | Daily base backup 02:00                                                                    |
| [optional/pooler.yaml](optional/pooler.yaml)                 | PgBouncer `Pooler`, not applied by default                                                 |
| [optional/networkpolicy.yaml](optional/networkpolicy.yaml)   | Ingress-only policy: app pods, the cluster itself, the operator, Prometheus; not applied   |
| [restore/cluster-restore.yaml](restore/cluster-restore.yaml) | Example `Cluster` for a point-in-time restore (the drill)                                  |
| [create-secrets.sh](create-secrets.sh)                       | Creates the three Secrets that nothing else creates                                        |
| [validate.sh](validate.sh)                                   | Renders and validates everything against the pinned CRDs                                   |

## Versions (pinned, not vendored)

| Component            | Version | Source                                                                                  | SHA-256 of the release manifest                                    |
| -------------------- | ------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| CloudNativePG        | 1.30.1  | `github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.1/cnpg-1.30.1.yaml`   | `37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb` |
| Barman Cloud plugin  | 0.15.1  | `github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.15.1/manifest.yaml` | `8f377ff4a7d0d3f74fc64b0f7ac4f449fc38ca9e83a40107cca2f9315a9bd920` |
| PostgreSQL image     | 17.11   | `ghcr.io/cloudnative-pg/postgresql:17.11-system-trixie`                                 |                                                                    |
| PgBouncer (optional) | 1.25.1  | `ghcr.io/cloudnative-pg/pgbouncer:1.25.1`                                               |                                                                    |

The hashes are what the manifests had when this was written; `validate.sh` checks them before using the files.

## Install, in this order

Cluster-admin steps, once per cluster. Do them on staging first.

1. [ ] **cert-manager** is installed (the plugin needs it). Expected: `cmctl check api` prints `The cert-manager API is ready`.
2. [ ] **Operator.**
   ```sh
   kubectl apply --server-side -f https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.1/cnpg-1.30.1.yaml
   kubectl -n cnpg-system rollout status deployment/cnpg-controller-manager
   ```
   Expected: `deployment "cnpg-controller-manager" successfully rolled out`.
3. [ ] **Barman Cloud plugin**, in the operator's namespace.
   ```sh
   kubectl apply -f https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.15.1/manifest.yaml
   kubectl -n cnpg-system rollout status deployment/barman-cloud
   ```
   Expected: `deployment "barman-cloud" successfully rolled out`.
4. [ ] **Edit the placeholders** in `cluster.yaml` (`storageClass`, sizes) and `objectstore.yaml`
       (`destinationPath`, `endpointURL`). `grep -rn 'CHANGE_ME\|example' deploy/postgres/*.yaml` must show only what you
       decided to keep. If the namespace is not `mira`, nothing else needs changing.
5. [ ] **Secrets**, in the application namespace:
   ```sh
   kubectl create namespace mira
   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... deploy/postgres/create-secrets.sh mira
   ```
   Expected: `secret/mira-pg-app-role created`, `secret/mira-pg-app-role labeled`, `secret/mira-db created`,
   `secret/mira-pg-backup-s3 created`.
6. [ ] **Apply.** `kubectl apply -k deploy/postgres -n mira`. Expected: a ConfigMap, an ObjectStore, a Cluster and a
       ScheduledBackup `created`.
7. [ ] **Wait for the cluster.** `kubectl -n mira get cluster mira-pg -w` reaches
       `STATUS: Cluster in healthy state` with `READY 3` (the bootstrap takes a few minutes).

## Verify (a human, on staging)

Each check names what a pass looks like. None of this has been run.

- [ ] **Three instances, one primary.** `kubectl -n mira get pods -l cnpg.io/cluster=mira-pg -L role`. Expected: three
      pods `Running`, `role` is `primary` for one and `replica` for two.
- [ ] **Generated Secret has the keys the chart reads.**
      `kubectl -n mira get secret mira-pg-app -o jsonpath='{.data}' | jq 'keys'`. Expected:
      `dbname fqdn-jdbc-uri fqdn-uri host jdbc-uri password pgpass port uri user username`.
- [ ] **Roles exist.** `kubectl cnpg status mira-pg -n mira` shows `mira_app` under managed roles as `reconciled`.
      (Without the plugin: `kubectl -n mira exec mira-pg-1 -c postgres -- psql -d mira -c '\du'` lists `mira_migrator`,
      `mira_dml`, `mira_app` with `mira_app` a member of `mira_dml`.)
- [ ] **The grants took effect** (the check that mattered locally). Connect as the DML role through a throwaway pod:
      `sh
kubectl -n mira run psql --rm -it --restart=Never --image=ghcr.io/cloudnative-pg/postgresql:17.11-system-trixie \
--env PGSSLMODE=require --env "PGPASSWORD=$(kubectl -n mira get secret mira-pg-app-role -o jsonpath='{.data.password}' | base64 -d)" \
-- psql -h mira-pg-rw -U mira_app -d mira -c 'create table x(i int)'
`
      Expected: `ERROR:  permission denied for schema public`. After the first `helm install` (which runs the
      migrations as `mira_migrator`), `-c 'select count(*) from etl_job'` must return `0`, not a permission error.
- [ ] **Plain-text connections are refused.** The same command with `PGSSLMODE=disable`. Expected: `pg_hba.conf rejects connection`.
- [ ] **WAL archiving works.** `kubectl -n mira get cluster mira-pg -o jsonpath='{.status.conditions}' | jq '.[] | select(.type=="ContinuousArchiving")'`.
      Expected: `"status": "True"`. If it is not, read `kubectl -n mira logs mira-pg-1 -c plugin-barman-cloud`.
- [ ] **First backup succeeded.** The `immediate: true` backup starts at once: `kubectl -n mira get backup`. Expected:
      `PHASE completed` within minutes. Then `LastBackupSucceeded` is `True` in the cluster conditions.
- [ ] **The CA the app will trust.** `kubectl -n mira get secret mira-pg-ca -o jsonpath='{.data.ca\.crt}' | base64 -d | openssl x509 -noout -subject -enddate`.
      Write the `notAfter` date into the infrastructure notes: it tells you whether the CA is re-issued every 90 days (see
      [infrastructure.md](../../docs/infrastructure.md), TLS failure modes).

Then continue with the chart: [deploy/helm/mira/README.md](../helm/mira/README.md#with-cloudnativepg), and
[docs/oidc-setup.md](../../docs/oidc-setup.md) for the login.

## Pooler (optional)

Not needed at the current size (docs/infrastructure.md section 5). To enable: `kubectl apply -f deploy/postgres/optional/pooler.yaml -n mira`,
then give `secrets.database` a `DATABASE_URL` whose host is `mira-pg-pooler-rw`. Keep `migration.databaseSecret` on the direct
`mira-pg-app` Secret. Check: `kubectl -n mira get pooler`, and a login as `mira_app` through the pooler (`psql -h mira-pg-pooler-rw`).
The pooler's TLS certificate and its names are documented but untested.

## Network policy (optional)

Decided in S2.6 (docs/network-policy.md): the chart's policies restrict what the **app** pods can reach, and
`optional/networkpolicy.yaml` restricts who can reach the **database** pods (ingress only). It is not in the
kustomization: apply it after the chart's policies work, `kubectl apply -f deploy/postgres/optional/networkpolicy.yaml -n mira`.
No egress policy for the database pods: they need the Kubernetes API, the object store and each other, and a mistake would
stop WAL archiving. The throwaway psql pod of the verification list below is blocked by it: add
`--labels app.kubernetes.io/name=mira` to that command, or use `kubectl cnpg psql`. Not applied or verified on a cluster.

## Validate offline

```sh
deploy/postgres/validate.sh
```

Expected last line: `Summary: 6 resources found parsing stdin - Valid: 6, Invalid: 0, Errors: 0, Skipped: 0`. It downloads the two
pinned release manifests (checking their hashes), turns their CRDs into JSON Schemas, renders the kustomization with the
`kustomize` image and runs `kubeconform -strict`. It proves the fields exist and have the right types. It does not prove the
operator accepts the values.
