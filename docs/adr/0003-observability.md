# 0003: Observability and request log retention

Status: accepted (session J, sprint stories S2.8 and S2.9). Date: 2026-10-26.

## Context

Until now the web app wrote free-text `console.log` lines (and none per request), exposed no metrics, and let `request_logs` grow forever with raw paths. The paths hold repo slugs and germplasm ids, so the table also kept what ADR 0002 says a caller must not be told. S2.8 and S2.9 add structured logs, a metrics endpoint, alerts and a retention job. Facts that shaped the choices:

- The ETL worker has no HTTP port and is bundled apart from SvelteKit (`vite.worker.config.ts`), so shared code cannot import `$app/*`.
- The access cache and the token rate limit are per pod (ADR 0001, ADR 0002), so counters about them are per pod too.
- `hooks.server.ts` is also edited by session K (security headers, CSP nonces, rate limits): the change there must stay small.
- The application role has DML only; the migrator owns DDL (`deploy/postgres/sql/roles.sql`).

## Decisions

### 1. Logs: one JSON line, primitives only

A tiny logger (`src/lib/server/log.ts`, no dependency) writes `{ts, level, msg, ...fields}` to stdout. Fields are strings, numbers and booleans; anything else is dropped, and strings are scrubbed of token-shaped values. A request line carries the request id, method, **route pattern**, status, duration, and the auth method and user id when there is one; never a path, a query string, a header or a cookie. The worker logs every step and outcome with the job id. The old `console.*` calls on the request path and in the worker went through it, keeping their messages.

### 2. `/metrics`: a bearer token of its own (recommended option, taken)

`GET /metrics` needs `Authorization: Bearer <METRICS_TOKEN>`, from a Secret the chart wires into the web pods. Unset means the endpoint does not exist (404). A session, an admin and a MIRA API token are not accepted: the endpoint ignores `locals`, and the hook lets it bypass the session lookup (with the probes). The cluster-level rule (NetworkPolicy: only the Prometheus namespace may reach the port) stays with session K as defence in depth.

Known limit: the path is the app's own port and so is reachable through the ingress; there it answers 401 to everyone without the token. Hiding it from the outside needs an ingress rule, which is K's.

### 3. Own small registry instead of `prom-client`

Three metric types and about thirty series do not justify a dependency with its default collectors and a larger audit surface. The registry (`src/lib/server/metrics.ts`) has counters, gauges and histograms, the text exposition, and a **hard series limit per metric** (1000) that counts what it refuses. Labels are route patterns and fixed names only; the allowed label names are asserted in a test.

### 4. The worker exposes no metrics; the queue is read from the database

Giving the worker a port would add a Service, a second ServiceMonitor target and NetworkPolicy rules for one process. The queue state lives in `etl_job` anyway, so the web pods read it at scrape time (`mira_etl_*`: states, finished totals and summed durations, oldest queued age). Every pod reports the same value (alerts use `max`). Per-step timings are in the worker's log lines. A real worker-side metric (for instance claim latency) would need that port: not done.

### 5. `request_logs` stores the route pattern; old rows are tolerated, not migrated

`event.route.id` replaces `event.url.pathname`. The dashboard expression already cut the repo segment and collapsed the germplasm id for both forms, so old and new rows group together and no data migration is needed. A migration would have to guess a route for each raw path (a regex over a table that is about to be pruned anyway) and would run as the migrator against a table the app is writing to. Old rows disappear with retention. Consequence: for up to the retention period after the upgrade the table still holds raw paths, with repo slugs; new rows hold none. Unmatched requests are stored under one fixed value, so a scanner cannot create rows or series.

### 6. Retention: a CronJob, 90 days, DML role, batches

`node retention.js` (own bundle, same image) deletes rows older than `retention.days` (default **90**) in 5000-row statements, each its own transaction, as the app's DML role through the existing `created_at` index (no migration, no DDL). Partitioning was rejected: it needs DDL at runtime or a partition-management job with migrator rights, for a table that is a few hundred bytes per row. The chart enforces at least 30 days because the dashboard's daily chart reads 30 days. The job's settings are read by the job only, so they are not in the app's env schema.

## Alternatives considered

- **NetworkPolicy only for `/metrics`.** No secret to rotate, but a NetworkPolicy is session K's work and depends on a CNI that enforces it; as the only guard it would leave the endpoint open to every pod in an unconfigured cluster.
- **Reusing a MIRA API token or the admin role for the scrape.** Mixes data access with operations and would make a user credential a monitoring credential.
- **`prom-client`.** See 3. Reconsider if the metric set grows a lot.
- **Normalising old rows in a migration.** See 5.
- **Retention inside the worker (a timer).** One less manifest, but it ties a maintenance job to the import worker's lifecycle and replica count (two workers would both run it), and the plan asked for a CronJob.

## Consequences

- Operators get one JSON line per request with an id they can quote, and a per-pod scrape with a bounded series count.
- `hooks.server.ts` changes are: `'/metrics'` joined the probe set, and the BrAPI-only timing block became one `observeRequest(event)` call with `stamp` and `finish`. Session K can add its header code around `observation.stamp(response)`.
- Counters reset when a pod restarts, and are per pod (so is the access cache and the token limit they describe).
- `mira_db_pool_open_connections` depends on `application_name` reaching `pg_stat_activity`; behind a pooler it may not.
- The Postgres alert rules depend on metric names of the operator that were not checked against a running one.
