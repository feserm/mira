# Postgres runbook: backups and the restore drill (S1.10)

Written for: an operator who has not seen this repository. Cluster layout and the reasoning:
[infrastructure.md](infrastructure.md). Manifests: [deploy/postgres/](../deploy/postgres/README.md).

> **This has not been executed.** No restore, no backup and no cluster was available when this was written. The
> manifest renders and validates against the pinned CRDs; the commands come from CloudNativePG 1.30 and Barman Cloud
> plugin 0.15 documentation and source. Treat every "expected" below as a prediction until you have ticked it. The
> acceptance criterion "a restore drill is documented and passes" is **not met until a human has run it** and filled in
> the measurement table in section 7.

Names: namespace `mira`, source cluster `mira-pg`, object store `mira-pg-backups`, restore cluster `mira-pg-restore`, Helm
release `mira` (Deployments `mira` and `mira-worker`). Adjust to your install.

## 1. Daily checks (and what to alert on)

- [ ] `kubectl -n mira get backup --sort-by=.metadata.creationTimestamp | tail -3`. Expected: the newest `PHASE` is `completed`, created within the last 26 hours.
- [ ] `kubectl -n mira get cluster mira-pg -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\n"}{end}'`. Expected: `ContinuousArchiving=True`, `LastBackupSucceeded=True`, `Ready=True`.
- [ ] WAL is leaving the volume. On the primary: `kubectl -n mira exec "$PRIMARY" -c postgres -- psql -At -c "select last_archived_time, now() - last_archived_time as behind, failed_count from pg_stat_archiver"`. Expected: `behind` under about 6 minutes, and a `failed_count` that does not grow.

Alerting is part of the chart (`monitoring.prometheusRule`, written in S2.8, see [observability.md](observability.md) section Alerts; **not yet verified against a running operator**). The signals it watches: `barman_cloud_cloudnative_pg_io_last_failed_backup_timestamp` newer than `..._last_available_backup_timestamp`,
no new `..._last_available_backup_timestamp` for 26 hours, conditions `ContinuousArchiving` and `LastBackupSucceeded` not `True`,
`cnpg_pg_stat_archiver_last_failed_time > cnpg_pg_stat_archiver_last_archived_time`, and the connection ratio
`cnpg_backends_total / cnpg_pg_settings_setting{name="max_connections"}` above 0.8.

## 2. Before the drill

- [ ] A backup exists and finished (section 1), and at least one import has run since, so the data is not empty.
- [ ] `PRIMARY=$(kubectl -n mira get cluster mira-pg -o jsonpath='{.status.currentPrimary}')` and `PG="kubectl -n mira exec $PRIMARY -c postgres -- psql -d mira -At -c"`.
- [ ] **Record the reference state** and the time `T` (UTC), with the output saved somewhere:
  ```sh
  date -u +%Y-%m-%dT%H:%M:%SZ      # T, the point you will restore to
  $PG "select 'etl_job', count(*) from etl_job union all select 'ro_crate_staging', count(*) from ro_crate_staging
       union all select 'trial', count(*) from trial union all select 'study', count(*) from study
       union all select 'user', count(*) from \"user\" union all select 'account', count(*) from account
       union all select 'migrations', count(*) from drizzle.__drizzle_migrations"
  $PG "select state, count(*) from etl_job group by state order by 1"
  $PG "select last_archived_time from pg_stat_archiver"   # archive position at T: used for the RPO figure
  ```
  Expected: one row per table with plausible counts; `migrations` equals the number of files in `drizzle/` (4 at the time of writing).
- [ ] **Wait for T to be archived.** WAL is archived when a segment fills or every 5 minutes. Wait 6 minutes after `T`
      (or run `$PG "select pg_switch_wal()"` on the primary), then check `last_archived_time` is later than `T`. Restoring to a moment that has not been archived yet fails.
- [ ] Note the clock: start the stopwatch for the RTO in section 7 when you apply the restore manifest.

## 3. Restore into a new cluster (the drill)

The live cluster and the app are not touched in this section.

- [ ] Copy [restore/cluster-restore.yaml](../deploy/postgres/restore/cluster-restore.yaml) and set `recoveryTarget.targetTime` to `T`
      (`2026-10-16T14:30:00Z` form) and the storage class. Leave `serverName: mira-pg` (the cluster that wrote the backups).
- [ ] `kubectl apply -f cluster-restore.yaml -n mira`. Expected: `cluster.postgresql.cnpg.io/mira-pg-restore created`. **Start the stopwatch.**
- [ ] `kubectl -n mira get pods -w`. Expected: a pod `mira-pg-restore-1-full-recovery-...` runs and reaches `Completed`, then `mira-pg-restore-1` starts and becomes `Running 1/1`.
- [ ] `kubectl -n mira get cluster mira-pg-restore`. Expected: `Cluster in healthy state`, `READY 1`. **Stop the first stopwatch lap** (database restored).
- [ ] If it does not come up: `kubectl -n mira logs job/mira-pg-restore-1-full-recovery` (or the pod of that name) and `kubectl -n mira describe cluster mira-pg-restore`. Typical causes: the recovery target is later than the last archived WAL (move `T` back), the object store credentials Secret is missing in this namespace, `serverName` does not match the source cluster's name, a lower `max_connections` than the source, a different PostgreSQL major version.

## 4. Verify the restored data

`PGR="kubectl -n mira exec mira-pg-restore-1 -c postgres -- psql -d mira -At -c"`

- [ ] **Row counts** equal the reference from section 2 (rows written after `T` must be absent; rows before it present):
      rerun the first query of section 2 with `$PGR`. Expected: the same numbers. A difference that is explained by writes
      between the reference query and `T` is fine; write it down.
- [ ] **Queue state.** `$PGR "select state, count(*) from etl_job group by state order by 1"`. Expected: the same states as at `T`. A job that was `running` at `T` is
      still `running` here with an expired lease: the worker reclaims it (or marks it `failed` when attempts are used up) within about a minute of starting, as described in [etl-worker.md](etl-worker.md). That is correct, not corruption.
- [ ] **Schema and roles.** `$PGR "select count(*) from drizzle.__drizzle_migrations"` equals the number of migration files. `kubectl -n mira exec mira-pg-restore-1 -c postgres -- psql -d mira -c '\du'`
      lists `mira_migrator`, `mira_dml` and `mira_app` (member of `mira_dml`).
- [ ] **The DML role can log in and cannot do DDL.** From a throwaway pod (as in the Postgres README, host `mira-pg-restore-rw`):
      `select count(*) from etl_job` returns a number, `create table x(i int)` answers `permission denied for schema public`.
- [ ] **A recent import is readable through BrAPI** once the app is switched (section 5), e.g. the trials of an ARC imported before `T`.

## 5. Switch the app to the restored cluster (real recovery, or the drill's end-to-end test)

Skip this section for a drill that only proves the data. If you do it on staging, remember that **every write after the switch
lands in the restored cluster**.

The restored cluster has its **own CA and server certificate**, so the app must trust the new CA: `config.db.caSecret` changes
with the host. The `mira_app` password is the same (it is part of the restored data and the Secret `mira-pg-app-role` still matches it).

- [ ] **Stop the writers.** `kubectl -n mira scale deploy/mira-worker --replicas=0`. Expected: the worker pod terminates (in at most the shutdown timeout, 60 s by default) and hands back a running job.
- [ ] **Build the new URL** without printing it:
      `sh
umask 077; f=$(mktemp)
kubectl -n mira get secret mira-db -o jsonpath='{.data.DATABASE_URL}' | base64 -d | sed 's/@mira-pg-rw:/@mira-pg-restore-rw:/' > "$f"
kubectl -n mira create secret generic mira-db-restore --from-file=DATABASE_URL="$f"; rm -f "$f"
`
      Expected: `secret/mira-db-restore created`.
- [ ] **Upgrade the release** onto the restored cluster (the chart's pre-upgrade migration Job runs against it first):
      `sh
helm upgrade mira deploy/helm/mira -n mira --reuse-values \
--set secrets.database.name=mira-db-restore \
--set migration.databaseSecret.name=mira-pg-restore-app --set migration.databaseSecret.key=uri \
--set config.db.caSecret.name=mira-pg-restore-ca --wait --timeout 10m
`
      Expected: the hook Job logs `migrate: nothing to apply, N already present` (or applies newer migrations), then the new pods become ready. `worker.replicas` returns to its value from the release.
- [ ] `kubectl -n mira exec deploy/mira -- node -e "fetch('http://127.0.0.1:3000/readyz').then(async r => console.log(r.status, await r.text()))"`. Expected: `200 ok`. **Stop the second stopwatch lap** (app serving). That is the RTO.
- [ ] Log in, open `/arcs`, open a previously imported ARC: the status shows the last import as succeeded. Open its `.../brapi/v2/trials`. Expected: the data from before `T`.

**Real disaster, same names.** If the original cluster is gone, restore under the name `mira-pg` instead, so `mira-pg-rw`, `mira-pg-app`
and `mira-db` keep working. The CA Secret `mira-pg-ca` is then regenerated with different content: run `kubectl -n mira rollout restart deploy/mira deploy/mira-worker` so the pods re-read `NODE_EXTRA_CA_CERTS`, and re-enable archiving in the restored cluster (the `plugins` block of `cluster.yaml`).

## 6. Roll back from the drill

Which steps apply depends on how far you went.

- [ ] **Only sections 3 and 4 were done** (the app never moved). Delete the restored cluster and its leftovers:
      `sh
kubectl -n mira delete cluster mira-pg-restore
`
      Expected: the pod and its PVCs disappear (`kubectl -n mira get pods,pvc | grep restore` prints nothing). The Secrets `mira-pg-restore-app`, `mira-pg-restore-ca`, `mira-pg-restore-server`, `mira-pg-restore-replication` go with it (owner references); if any remain, delete them by name. **Never** run `kubectl delete cluster mira-pg`.
- [ ] **The app was switched (section 5).** First point the release back, then delete:
      `sh
helm upgrade mira deploy/helm/mira -n mira --reuse-values \
--set secrets.database.name=mira-db \
--set migration.databaseSecret.name=mira-pg-app --set migration.databaseSecret.key=uri \
--set config.db.caSecret.name=mira-pg-ca --wait --timeout 10m
kubectl -n mira delete secret mira-db-restore
kubectl -n mira delete cluster mira-pg-restore
`
      Expected: pods roll back to the original cluster, `readyz` is `200 ok`. **Writes made while the app used the restored cluster are discarded**; on a real system decide that before you roll back.
- [ ] The drill wrote nothing to the object store, because the restore manifest has no `plugins` block. If you added archiving to the restored cluster, delete its prefix in the bucket (`mira-pg-restore/` under the bucket) too.
- [ ] Confirm production is unchanged: `kubectl -n mira get cluster mira-pg` is healthy, and the section 2 reference queries on the original cluster still show the counts you recorded (plus anything written since).

## 7. Measurements (fill in)

The "target" column is a guess from the settings, not an agreed objective: agree the real RTO/RPO with whoever depends on the data, then compare.

| Measurement                                                   | How                                                                                    | Guess from settings       | Measured | Date | By  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------- | -------- | ---- | --- |
| Base backup duration and size                                 | `kubectl get backup` (`startedAt`, `stoppedAt`), bucket size                           |                           |          |      |     |
| WAL archive lag in normal operation                           | section 1, `behind`                                                                    | under 6 min               |          |      |     |
| **RPO**: newest data lost if the whole cluster dies right now | time between the last write and the last WAL in the bucket, at the moment of the drill | about 5 min + upload time |          |      |     |
| Restore: apply to cluster healthy                             | stopwatch lap 1 (section 3)                                                            |                           |          |      |     |
| **RTO**: apply to app serving on the restored cluster         | stopwatch lap 2 (section 5), including the Helm upgrade                                |                           |          |      |     |
| Restored target reached exactly                               | `select max(updated_at) from etl_job` against `T`                                      | within one transaction    |          |      |     |
| Drill passed (all boxes in sections 3, 4, 6)                  |                                                                                        |                           |          |      |     |

## 8. Things that will bite

- **The credentials for the object store and the `mira-pg-app-role` password live only in Secrets in this cluster.** If the cluster
  and its Secrets are lost, the backups cannot be read and the roles cannot be re-created with the same password. Keep copies in your secret store.
- **Retention is 30 days** (`ObjectStore.spec.retentionPolicy`). A restore target older than the oldest base backup fails.
- **A restore does not restore the Kubernetes objects** (Secrets, the ObjectStore, the Cluster spec), only the data. Keep `deploy/postgres` and the Secrets reproducible.
- Restoring a cluster with `plugins` pointing at the production archive and the same name as another live cluster would make two clusters archive to one path. The restore example avoids it by not archiving, and by naming the cluster differently.
