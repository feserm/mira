# Infrastructure decisions (S1.8, S1.10)

Written for: whoever applies the Postgres manifests and registers the OIDC application on staging.

Status: **drafted in session E, nothing here has run on a cluster or against a real GitLab.** What was
run locally (throwaway Postgres 17 and PgBouncer in Docker, the real migrator, worker and web bundles)
is marked "ran locally". Everything else is a decision backed by documentation or source reading, and
says so. Manifests: [deploy/postgres/](../deploy/postgres/). Runbooks: [oidc-setup.md](oidc-setup.md),
[postgres-runbook.md](postgres-runbook.md).

Versions pinned: CloudNativePG operator **1.30.1**, Barman Cloud plugin **0.15.1**, PostgreSQL **17**
(image `ghcr.io/cloudnative-pg/postgresql:17.11-system-trixie`, same major as `compose.yaml` and CI),
PgBouncer **1.25.1** (the CloudNativePG image).

## 1. OIDC client: confidential

Register the GitLab application as **confidential** and set `secrets.oidcClientSecret`. The app works
either way (PKCE is on in both cases; `OIDC_CLIENT_SECRET` is optional).

Why: the app stores the user's refresh token and the worker uses it unattended, hours after login. A
refresh token is a long-lived credential sitting in the `account` table and in every backup; since
S2.3 it is stored encrypted (key derived from `BETTER_AUTH_SECRET`, [secret-rotation.md](secret-rotation.md)). Against a public client, anyone who gets that token and the client id (public) can
refresh it. Against a confidential client they also need the client secret, which lives only in a
Kubernetes Secret and never in the database or its backups. The cost is one more Secret and a rotation
step.

Failure modes:

- Wrong or stale secret: login fails at the token exchange (`invalid_client`); the worker's refresh fails
  the same way and the job fails with "sign in again", which will not help. Check the secret first.
- **Rotating the secret** ("Renew secret" in GitLab) breaks the old one at once. Update the Secret, then
  `kubectl rollout restart` web and worker (Secret changes do not roll pods). Until then logins and
  refreshes fail.
- GitLab rotates refresh tokens: each refresh invalidates the old access _and_ refresh token (GitLab
  OAuth docs). better-auth reads the row, refreshes and writes back with no lock, so if the web app and
  the worker refresh the same account in the same second, the loser holds an invalidated token and the
  user must sign in again. Rare, not prevented. Watch for it during the token test in
  [oidc-setup.md](oidc-setup.md).
- better-auth's refresh request sends `client_id` (and `client_secret` when set) but no `redirect_uri`
  (read in `@better-auth/core` 1.6.29). GitLab's docs show `redirect_uri` on refresh. Whether GitLab
  accepts it without is unverified; it is step 6 of the token test.

## 2. Cluster shape

| Decision        | Choice                                                        | Why                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instances       | **3**, asynchronous replication                               | A node drain or crash leaves a primary plus a replica. With 2 there is no HA while one node is down. The data is mostly re-importable from PLANTdataHUB, so async (small RPO on failover) is acceptable; sync would block writes when both replicas are down.   |
| Storage         | **20 Gi** data + **8 Gi** WAL per instance, class `CHANGE_ME` | Placeholder size, to be measured: `ro_crate_staging.raw_ro_crate` (jsonb per ARC) and `request_logs` (unbounded, M2) dominate. A separate WAL volume means a stuck archiver fills only the WAL volume, not the data. Pick a class that allows volume expansion. |
| Resources       | requests 500m CPU / 1 Gi; limit 1 Gi memory, no CPU limit     | Memory request = limit so the pod cannot be OOM-evicted before its limit. `shared_buffers` 256 MB. Guess, not measured.                                                                                                                                         |
| max_connections | **100** (headroom check below)                                | See the table below.                                                                                                                                                                                                                                            |
| Pooler          | **No PgBouncer now**; optional manifest provided and tested   | Connection budget fits. See section 5.                                                                                                                                                                                                                          |
| Spread          | preferred anti-affinity                                       | `required` needs 3 schedulable nodes; switch it on once the cluster has them.                                                                                                                                                                                   |

Connection budget at the chart defaults (2 web replicas, 1 worker, `DB_POOL_MAX` 10 for each; the
worker shares the ConfigMap value). Only the primary counts; replicas must allow at least as many.

| Consumer                                    | Connections  |
| ------------------------------------------- | ------------ |
| web, 2 replicas x 10                        | 20           |
| worker, 1 x 10                              | 10           |
| rollout surge: 1 extra web + 1 extra worker | 20           |
| migration Job (single connection)           | 1            |
| operator, exporter, admin sessions (guess)  | about 10     |
| **Peak**                                    | **about 61** |

`max_connections=100` minus 3 reserved leaves 97, so the peak is about 63 percent. Rule: add a Pooler
(or lower `DB_POOL_MAX`) before `(web + worker replicas + 2 surge) x DB_POOL_MAX + 10` exceeds 80. At
pool size 10 that is more than 5 web plus worker pods in steady state (3 today). Alert on
`cnpg_backends_total / cnpg_pg_settings_setting{name="max_connections"}` above 0.8.

## 3. Backups

| Decision    | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Method      | **Barman Cloud plugin** (`ObjectStore` + `Cluster.spec.plugins`). The in-tree `barmanObjectStore` is deprecated since CloudNativePG 1.26. The plugin needs **cert-manager** (its manifest creates `Certificate`s).                                                                                                                                                                                                                                                                                                                                                                        |
| Target      | S3-compatible bucket `s3://example-mira-pg-backups/`, endpoint `https://s3.example.org`, credentials in Secret `mira-pg-backup-s3`. All placeholders.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| WAL         | Continuous archiving, gzip. CloudNativePG's default `archive_timeout` is 5 min, so **worst-case loss of the whole cluster is about 5 minutes plus upload time** (this is the RPO to measure in the drill).                                                                                                                                                                                                                                                                                                                                                                                |
| Base backup | `ScheduledBackup` daily at 02:00 (cron has six fields, seconds first: `0 0 2 * * *`), `immediate: true`, `target: prefer-standby`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Retention   | `retentionPolicy: 30d` on the `ObjectStore` (recovery window: any point in the last 30 days). Costs roughly 30 base backups plus their WAL: size the bucket accordingly.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Alerting    | Rules are S2.8. Alert on: `barman_cloud_cloudnative_pg_io_last_failed_backup_timestamp` newer than `..._last_available_backup_timestamp`; time since `..._last_available_backup_timestamp` above 26 h; cluster condition `ContinuousArchiving` not `True`; cluster condition `LastBackupSucceeded` not `True`; `cnpg_pg_stat_archiver_last_failed_time > cnpg_pg_stat_archiver_last_archived_time` (CloudNativePG's own sample rule); `cnpg_collector_pg_wal_archive_status{value="ready"}` growing. Page the **cluster operators** (whoever owns the namespace), not the app developers. |

Failure mode that matters most: if archiving fails, WAL piles up on the WAL volume until Postgres stops.
That is why the archiver alert is more urgent than the backup alert, and why WAL has its own volume.

## 4. Roles, secrets, TLS

**Roles** (SQL in [deploy/postgres/sql/roles.sql](../deploy/postgres/sql/roles.sql), ran locally):

- `mira_migrator`: owner of the database and of every object. Created by `bootstrap.initdb.owner`, so
  CloudNativePG generates the Secret `mira-pg-app` for it (keys below). Used only by the migration Job.
- `mira_dml`: `NOLOGIN` group role holding the privileges (SELECT/INSERT/UPDATE/DELETE on tables, USAGE on
  sequences) plus `ALTER DEFAULT PRIVILEGES FOR ROLE mira_migrator`, so future migrations need no new GRANT.
- `mira_app`: login role, member of `mira_dml`, declared in `Cluster.spec.managed.roles`. Used by the web
  app and the worker. Cannot create, alter or drop anything, and cannot read the `drizzle` schema.

The group role is what lets the SQL run at bootstrap (`postInitApplicationSQLRefs`) before the managed
role exists. Managed roles do **not** get a generated Secret: the operator reads a Secret of type
`kubernetes.io/basic-auth` that you create. Only the owner's `-app` Secret is generated.

**Secrets** (all created by hand before the chart; nothing is committed):

| Secret             | Created by                     | Key(s)                                                                                                             | Feeds                                           |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `mira-pg-app`      | CloudNativePG (owner)          | `uri`, `username`, `user`, `password`, `host`, `port`, `dbname`, `pgpass`, `jdbc-uri`, `fqdn-uri`, `fqdn-jdbc-uri` | `migration.databaseSecret` (key `uri`)          |
| `mira-pg-app-role` | you (`basic-auth`)             | `username`, `password`                                                                                             | `managed.roles` password only                   |
| `mira-db`          | you                            | `DATABASE_URL` = `postgresql://mira_app:<password>@mira-pg-rw:5432/mira`                                           | `secrets.database`                              |
| `mira-pg-ca`       | CloudNativePG (`<cluster>-ca`) | `ca.crt`, `ca.key`                                                                                                 | `config.db.caSecret` (only `ca.crt` is mounted) |

Key names read from the operator source (`pkg/specs/secrets.go`, v1.30.1). The chart cannot build a URL
from `username`/`password`, so `mira-db` is assembled by a script
([create-secrets.sh](../deploy/postgres/create-secrets.sh)) from the same password it puts in
`mira-pg-app-role`. `mira-pg-ca` also holds the CA **private key**, so the chart mounts it with an `items`
list that projects only `ca.crt` into the pod.

**TLS.** `DB_SSL=verify-full`, host `mira-pg-rw` (in the server certificate's names:
`<cluster>-rw`, `.<ns>`, `.<ns>.svc`, `.svc.cluster.local`, read from `GetClusterAltDNSNames`). The app
trusts the operator's CA through `NODE_EXTRA_CA_CERTS`. The chart's `extraEnv` could set the variable but
cannot mount a file, and does not reach the migration Job at all, so the chart gets one new value,
`config.db.caSecret`, which mounts the CA read-only and sets `NODE_EXTRA_CA_CERTS` in the web, worker and
migration pods. The Cluster rejects non-TLS connections to the `mira` database (`hostnossl ... reject`).
CloudNativePG 1.30 allows TLS 1.3 only, which Node 22 speaks.

Ran locally (Postgres with a private CA, the real migrator bundle): `verify-full` without the CA fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`; with `NODE_EXTRA_CA_CERTS` it connects; with a certificate that does not
name the host it fails with `ERR_TLS_CERT_ALTNAME_INVALID`. Not run: a real CloudNativePG certificate.
Failure modes:

- **CA rotation.** `NODE_EXTRA_CA_CERTS` is read once at process start. The operator's certificates default
  to 90 days (`CERTIFICATE_DURATION`) and the source applies that to the CA as well; I did not run the
  operator to see whether and when it re-issues the CA. If it does, pods that started before must be
  restarted (the mounted file updates, the process does not re-read it). Check on staging with
  `openssl x509 -enddate` on the Secret's `ca.crt`. A fix is a long-lived CA via cert-manager
  (`serverCASecret`/`serverTLSSecret`, supported by CloudNativePG) and is a follow-up, not drafted here.
- A DATABASE_URL host that is not in the certificate's names fails at connect time, not at login.
- postgres.js has no option for a CA file path in the URL (only `sslrootcert=system` is recognised, in its
  `connection.js`/`index.js`), which is why the CA goes in through `NODE_EXTRA_CA_CERTS` and the mode through `DB_SSL`.

## 5. Pooler (PgBouncer): compatible, not enabled

Design: the worker's lock is `pg_advisory_xact_lock` (transaction-scoped), the queue claim is one
`FOR UPDATE SKIP LOCKED` statement in a transaction, and there is no LISTEN/NOTIFY, so transaction pooling
is compatible. **Prepared statements** were the open question, so it was tested with the real code (ran
locally, PgBouncer 1.25.1 in transaction mode, mira_app role):

| PgBouncer setting                       | `DB_PREPARE`   | 2 workers, 20 jobs, 400 concurrent transactions                                                                                                                                                                                    |
| --------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default (`max_prepared_statements` 200) | default (true) | every job claimed once, all 20 loaded; 400 of 400 transactions fine; web app serves and logs through it                                                                                                                            |
| `max_prepared_statements = 0`           | `false`        | same result                                                                                                                                                                                                                        |
| `max_prepared_statements = 0`           | default (true) | **broken**: 267 of 400 transactions failed with `prepared statement ... does not exist`; the job test misbehaved (53 claims for 20 jobs, only 4 ARCs with data; not investigated further, the configuration is simply unsupported) |

So with the CloudNativePG image (1.25.1) nothing is needed. `DB_PREPARE=false` (new, default true) is the
fallback for a PgBouncer older than 1.21 or with `max_prepared_statements=0`. The migration Job must
connect to `mira-pg-rw` directly, never through the pooler. A Pooler needs the pooler's service name in
`Cluster.spec.certificates.serverAltDNSNames` (done in `cluster.yaml`) so `verify-full` matches; whether the
pooler presents that certificate to clients is from the docs, not tested.
