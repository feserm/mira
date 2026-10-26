# Logs, metrics, alerts and request log retention (S2.8, S2.9)

Written for: an operator who runs MIRA on Kubernetes and has not read the code. The decisions behind it:
[adr/0003-observability.md](adr/0003-observability.md). What was and was not verified: the S2.8/S2.9 section of the
[sprint plan](deployment-sprint-plan.md).

> **Not verified on a cluster.** Everything here was exercised with unit and integration tests, the built bundles, and
> `helm template`/`kubeconform`/`promtool` on the rendered chart. No Prometheus, no log shipper and no alert receiver
> was available. The "Not verified" list at the end is the checklist for staging.

## Logs

Every line the web app and the worker write is **one JSON object on stdout**. Collect stdout; there is nothing on stderr.

```json
{
	"ts": "2026-10-26T08:12:43.115Z",
	"level": "info",
	"msg": "request",
	"requestId": "6f0c...",
	"method": "GET",
	"route": "/[repo]/brapi/v2/trials",
	"status": 200,
	"durationMs": 14.82,
	"authMethod": "token",
	"userId": "..."
}
```

| Field                                                                   | Where             | Meaning                                                                                                                                                                |
| ----------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts`, `level`, `msg`                                                    | every line        | ISO time, `info` / `warn` / `error`, the message                                                                                                                       |
| `requestId`                                                             | web request lines | the `X-Request-Id` of the request (also in the response header)                                                                                                        |
| `method`, `route`, `status`, `durationMs`                               | web request lines | `route` is the route **pattern** (`/[repo]/brapi/v2/trials`), never the path; `(unmatched)` when no route matched                                                      |
| `authMethod`, `userId`                                                  | web request lines | `session` or `token`, and the MIRA user id; only when the request authenticated (BrAPI sets it, pages carry the user id of the session)                                |
| `event`, `jobId`, `arcId`, `kind`, `attempt`, `maxAttempts`, `workerId` | worker lines      | `event` is `etl.step`, `etl.job`, `etl.claim_lost`, `etl.heartbeat_failed`, `etl.poll_failed`, `etl.stopping`, `etl.started`; `jobId` plays the part of the request id |
| `step`, `previousStep`, `previousStepMs`                                | `etl.step`        | the step that began, and how long the one before it took                                                                                                               |
| `outcome`, `durationMs`, `lastStep`, `lastStepMs`, `transient`          | `etl.job`         | `running`, `succeeded`, `retry`, `failed`, `claim_lost`, `worker_lost`, `released`, ...                                                                                |
| `event: retention.done`                                                 | retention job     | `deleted`, `batches`, `days`, `cutoff`, `durationMs`                                                                                                                   |

Levels on request lines: 5xx is `error`, 4xx is `warn`, the rest `info`. The existing message texts were kept (`etl: job=... succeeded in 3.2s`), so
a grep that worked before still works.

**Quiet on purpose:** `/healthz`, `/readyz` and `/metrics` write no log line, no `request_logs` row, and are not counted in the request metrics.

**Request id.** An inbound `X-Request-Id` is used if it is 1 to 64 characters of `A-Z a-z 0-9 . _ -`; anything else is replaced by a new UUID. The ingress can set it; give the same id to a user's bug report and `grep` for it.

**What is never logged:** `Authorization` headers, cookies, API tokens, GitLab tokens, OIDC codes, request bodies, and query strings (BrAPI filters live there). The logger writes only strings, numbers and booleans, so an `Error` or a header map passed by mistake is dropped, and strings are scrubbed of anything shaped like a MIRA API token or a `Bearer` credential. Error logging keeps the rule "the message, never the object". A test sends a bearer token, a cookie and a query string through the hook and checks that none appears in the log or in `/metrics`.

**Unhandled errors** (a thrown exception in a page or endpoint) go through SvelteKit's `handleError`, which logs `Unhandled error: <message>` with `requestId`, `route` and `status`, never the error object or its stack. The only other non-JSON output is adapter-node's single `Listening on http://...` line at start.

**Log shipping** (Loki, Elastic, ...) is the cluster's job; the lines need no parsing rules beyond JSON.

## Metrics

`GET /metrics`, Prometheus text format, on the web pods' port (container port `http` 3000, Service port 80).

**Protection.** A bearer token of its own, `METRICS_TOKEN` (at least 32 characters), from a Secret:

```sh
kubectl -n mira create secret generic mira-metrics --from-literal=METRICS_TOKEN="$(openssl rand -hex 32)"
# chart: --set secrets.metricsToken.name=mira-metrics
```

- No `METRICS_TOKEN` configured: the endpoint **does not exist** (404).
- No or a wrong credential: 401 with `WWW-Authenticate: Bearer`. A signed-in user's cookie, an admin session and a MIRA API token (`mira_...`) are all just wrong credentials here: the hook does not even look up the session for this path.
- The comparison is constant time on SHA-256 digests.
- **The path is reachable through the ingress** (it is the same port as the app), and answers 401 to anyone without the token. If you want it unreachable from outside the cluster, that is a rule for the ingress controller or for the NetworkPolicy (K): the scrape comes from inside the cluster, straight to the pod.
- Rotate it like the other Secrets ([secret-rotation.md](secret-rotation.md)): change the Secret, `kubectl rollout restart deploy/<release>-mira`, and the Prometheus side picks up the Secret on its next reload.

**Per pod.** Every web pod has its own counters, which restart at zero when the pod restarts. Aggregate with `sum`; for values that every pod reads from the database (the `mira_etl_*` family) use `max`. The **worker serves no port**, so it exposes no metrics: the import queue is read from `etl_job` by the web pods, and what the worker does is in its log lines.

**Cardinality is a hard rule.** Label values are route patterns (`event.route.id`, a fixed set of about twenty), HTTP methods from a fixed list (anything else is `OTHER`), status classes and fixed outcome names. Never a path, repo slug, user id, ARC id or token id. As a backstop every metric stops creating series at 1000 and counts what it refused in `mira_metrics_dropped_series_total` (an alert watches it). A test lists the label names allowed in the output.

| Metric                                                                                  | Type            | Labels                                                                      | What                                                                                                                                               |
| --------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mira_http_requests_total`                                                              | counter         | `method`, `route`, `status_class`                                           | requests served                                                                                                                                    |
| `mira_http_request_duration_seconds`                                                    | histogram       | `method`, `route`, `status_class`                                           | duration                                                                                                                                           |
| `mira_brapi_auth_failures_total`                                                        | counter         | `reason` (`not_signed_in`, `invalid_token`)                                 | BrAPI 401s                                                                                                                                         |
| `mira_token_rate_limit_hits_total`                                                      | counter         |                                                                             | 429s from the per-token limit                                                                                                                      |
| `mira_arc_access_total`                                                                 | counter         | `outcome` (`allow`, `deny`, `unusable_login`, `unavailable`)                | answers of the ARC access check, cached or not                                                                                                     |
| `mira_arc_access_cache_total`                                                           | counter         | `result` (`hit`, `miss`, `shared`)                                          | access check lookups                                                                                                                               |
| `mira_gitlab_project_requests_total`                                                    | counter         | `credentials` (`anonymous`, `user`), `status_class` (`2xx`..`5xx`, `error`) | calls to PLANTdataHUB by the access check                                                                                                          |
| `mira_request_logs_flushed_total`, `_flush_failures_total`, `_dropped_total`            | counter         |                                                                             | the queue that writes `request_logs`                                                                                                               |
| `mira_request_logs_queue_length`                                                        | gauge           |                                                                             | rows waiting                                                                                                                                       |
| `mira_etl_jobs`                                                                         | gauge           | `state` (`queued`, `running`)                                               | jobs waiting or running, from `etl_job`                                                                                                            |
| `mira_etl_jobs_finished_total`, `mira_etl_job_seconds_total`                            | counter         | `state` (`succeeded`, `failed`)                                             | finished jobs and their summed running time (average = ratio of the two)                                                                           |
| `mira_etl_oldest_queued_age_seconds`                                                    | gauge           |                                                                             | age of the oldest due job still queued                                                                                                             |
| `mira_db_pool_max_connections`, `mira_db_pool_open_connections`, `mira_db_ping_seconds` | gauge           |                                                                             | pool size, connections this pod holds (by `application_name` in `pg_stat_activity`), time of `select 1` including the wait for a pooled connection |
| `mira_metrics_dropped_series_total`, `mira_metrics_collector_errors_total{collector}`   | counter         |                                                                             | the cardinality backstop; scrape-time collectors that failed                                                                                       |
| `process_*`, `nodejs_heap_used_bytes`                                                   | counter / gauge |                                                                             | CPU, resident memory, start time, V8 heap                                                                                                          |

The database-backed collectors run at scrape time under a 2 second bound each; if the database is down the scrape still succeeds without those series and `mira_metrics_collector_errors_total` moves.

**Enable the scrape and the alerts** (both objects need the Prometheus operator CRDs and are off by default):

```sh
--set secrets.metricsToken.name=mira-metrics \
--set monitoring.serviceMonitor.enabled=true --set monitoring.serviceMonitor.labels.release=kube-prometheus-stack \
--set monitoring.prometheusRule.enabled=true  --set monitoring.prometheusRule.labels.release=kube-prometheus-stack
```

The ServiceMonitor scrapes every ready web pod (the Service's endpoints) at `/metrics`, with the Secret as bearer credential. The Secret must be in the same namespace as the ServiceMonitor. Example values: [ci/monitoring-values.yaml](../deploy/helm/mira/ci/monitoring-values.yaml).

**For the NetworkPolicy (session K):** ingress to the web pods on TCP 3000 now also comes from the Prometheus namespace (path `/metrics`). The egress list of the web and worker pods is unchanged. **One new pod kind:** the retention CronJob pods (label `app.kubernetes.io/component: retention`) need egress to Postgres only, like the migration Job, and nothing else.

## Alerts

`monitoring.prometheusRule.enabled` renders one `PrometheusRule` with 19 rules (thresholds are values; the rules are tested with `promtool test rules`, see `ci/rules-test.yaml`). Series that do not come from MIRA are marked.

| Alert                                         | Fires when                                                                                                        | First thing to look at                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `MiraNoReadyReplicas` (critical)              | no web pod ready for 5 minutes (`kube_deployment_status_replicas_available`, kube-state-metrics)                  | `kubectl get pods`, `/readyz` (the database), the pod log                                            |
| `MiraNotScraped` (critical)                   | no scrape target is `up` for 5 minutes                                                                            | no ready pod, or the `METRICS_TOKEN` Secret does not match what the pods run with (restart the pods) |
| `MiraPodsNotReady` (warning)                  | a web pod unavailable for 15 minutes                                                                              | rollout, node pressure                                                                               |
| `MiraWorkerNotRunning` (warning)              | no worker available for 10 minutes (only when the worker is enabled)                                              | `kubectl logs deploy/<release>-mira-worker`                                                          |
| `MiraHigh5xxRate` (warning)                   | more than 5% of requests are 5xx for 10 minutes (and at least 0.02 requests per second)                           | log lines with `level: error`, grouped by `route`; then by `requestId`                               |
| `MiraSlowRequests` (warning)                  | p95 duration above 5 s for 10 minutes                                                                             | PLANTdataHUB latency (`mira_gitlab_project_requests_total`), `mira_db_ping_seconds`                  |
| `MiraArcAccessUnavailable` (warning)          | over 20% of access checks end `unavailable` for 10 minutes                                                        | PLANTdataHUB; the refresh lock ([oidc-setup.md](oidc-setup.md) section 6)                            |
| `MiraRequestLogsLost` (warning)               | `request_logs` inserts fail or rows are dropped                                                                   | the database; requests are unaffected                                                                |
| `MiraMetricsSeriesDropped` (warning)          | a metric hit its series limit                                                                                     | a label bug: find the metric with the most series                                                    |
| `MiraDbPoolNearLimit`, `MiraDbSlow` (warning) | pool over 90% for 10 minutes; `select 1` over 1 s for 5 minutes                                                   | `config.db.poolMax`, slow queries, [infrastructure.md](infrastructure.md) connection budget          |
| `MiraImportFailed` (warning)                  | a job reached `failed` in the last 15 minutes (`max` over pods)                                                   | the ARC page (it shows the error), the worker line with `outcome: failed`                            |
| `MiraImportQueueStuck` (warning)              | the oldest due queued job is older than 15 minutes for 5 minutes                                                  | is a worker running, is it busy ([etl-worker.md](etl-worker.md))                                     |
| `MiraRetentionNotRunning` (warning)           | no successful retention run for 36 hours (`kube_cronjob_status_last_successful_time`)                             | `kubectl get jobs`, the newest `*-retention-*` job's log                                             |
| `MiraPostgresBackupFailed` (critical)         | `barman_cloud_cloudnative_pg_io_last_failed_backup_timestamp` is newer than `..._last_available_backup_timestamp` | [postgres-runbook.md](postgres-runbook.md) section 1                                                 |
| `MiraPostgresBackupTooOld` (critical)         | no good backup for `backupMaxAgeHours` (26)                                                                       | same                                                                                                 |
| `MiraPostgresBackupMetricMissing` (warning)   | the backup metric does not exist for 3 hours                                                                      | no backup yet, or a wrong metric name or label matcher                                               |
| `MiraPostgresArchivingFailing` (critical)     | `cnpg_pg_stat_archiver_last_failed_time` is newer than `..._last_archived_time` for 10 minutes                    | the object store, `kubectl get cluster` conditions                                                   |
| `MiraPostgresConnectionsHigh` (warning)       | `cnpg_backends_total / cnpg_pg_settings_setting{name="max_connections"}` above 0.8 for 10 minutes                 | replicas x pool size, the retention and migration Jobs                                               |

**The Postgres rules** are written against metrics of CloudNativePG and the Barman Cloud plugin, not of MIRA. The names are the ones in [postgres-runbook.md](postgres-runbook.md) section 1 and were **not checked against a running operator**. The runbook also names two cluster conditions (`ContinuousArchiving`, `LastBackupSucceeded`): there is no stock Prometheus metric for a condition, so the rules watch the facts behind them (archiver failure newer than success; failed backup newer than the last good one). The label matcher defaults to `namespace="<postgres namespace>",pod=~"<clusterName>-[0-9]+"`; set `monitoring.prometheusRule.postgres.selector` if your scrape labels differ, and turn the group off with `monitoring.prometheusRule.postgres.enabled=false` if Postgres is not CloudNativePG.

Alert **delivery** (Alertmanager routes, receivers) is the cluster's.

## Request log retention

`request_logs` is the table behind the dashboard's endpoint statistics. It gets one row per BrAPI request, so it grows without bound unless something deletes from it.

- **What stores what.** Since S2.9 the `endpoint` column holds the **route pattern** (`/[repo]/brapi/v2/trials`), not the path. This also removes repo slugs and germplasm ids from the table. Rows written before then still hold raw paths.
- **Old rows are not migrated.** The dashboard reads both forms with one expression (`request-analytics.ts`), so they land in the same group. They age out with retention: after the retention period after the upgrade, no raw path is left. Until then those rows contain repo slugs, which the dashboard never shows (the request totals include traffic to ARCs a viewer cannot read, as noted in ADR 0002; the route pattern does not change that, it only stops new slugs from being stored).
- **The job.** A CronJob (`retention.*`, enabled by default, 03:17 UTC daily) runs `node retention.js` from the same image. It deletes rows with `created_at` older than `retention.days` (default **90**), 5000 rows per statement, each in its own short transaction, pausing 100 ms between batches. It runs as the application's **DML-only role** (the `secrets.database` URL): `DELETE` needs no DDL, and the `created_at` index it uses already exists, so there is no migration. A second run finds nothing. It logs one line (`event: retention.done`, `deleted`, `batches`, `cutoff`).
- **Settings.** Chart: `retention.days` (at least 30, because the dashboard's daily chart shows 30 days and would otherwise show gaps), `retention.batchSize`, `retention.schedule`. The job reads `REQUEST_LOGS_RETENTION_DAYS` and `REQUEST_LOGS_RETENTION_BATCH`; the web app and the worker do not, so they are not part of the app's env validation.
- **What the dashboard shows afterwards.** The daily chart reads at most the last 30 days: unchanged. The endpoint popularity and the median response time read **all stored rows**, which retention bounds to the last 90 days (they used to cover all time).
- **After a big first run** Postgres frees the space for reuse by autovacuum; the table file does not shrink. That is fine: it stops growing.
- **Run it by hand:** `kubectl -n mira create job --from=cronjob/<release>-mira-retention retention-now`, then `kubectl -n mira logs job/retention-now`.
- **Failure:** `MiraRetentionNotRunning` fires after 36 hours without a success (it needs one earlier success to exist as a series, so a job that never worked is caught by looking at `kubectl get cronjob` after the first night). The job exits 1 and logs `event: retention.failed` with the reason (for example a wrong password or an unreachable database).

## Not verified, needs staging (session L)

- The scrape through the real Prometheus: ServiceMonitor selected (label `release`), the Secret in the right namespace, `up == 1` for every web pod, TLS/ingress not in the way.
- That the alert rules load in the operator, fire on a real fault (stop the worker, fail a job, block PLANTdataHUB), and that Alertmanager delivers them.
- The retention job on the real cluster: the first run against a real table, its duration for the real row count, the `restricted` pod security profile, the `retention` pods' egress under the NetworkPolicy.
- Log shipping and that the JSON lines parse in the chosen stack; whether the ingress passes or sets `X-Request-Id`.
- Metric volume per pod (series count, scrape size) with real traffic; `mira_db_pool_open_connections` behind PgBouncer (it counts by `application_name`, which a pooler may not pass on).
- The Postgres operator's metric names (`barman_cloud_cloudnative_pg_io_*`, `cnpg_pg_stat_archiver_*`, `cnpg_backends_total`, `cnpg_pg_settings_setting`) and their labels, and the kube-state-metrics series (`kube_deployment_status_replicas_*`, `kube_cronjob_status_last_successful_time`).
- That the worker's JSON lines carry `jobId` through a real import, and the importing user's id is not logged there (it is not: `requestedBy` is not a field).
