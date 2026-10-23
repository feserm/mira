# ETL worker (S1.11)

The ETL no longer runs inside the HTTP request. The `extract`, `transform` and `load` form actions
authenticate, insert a row into `etl_job` and return. A separate **worker** process (same image,
`node worker.js`) claims jobs and runs the pipeline. This page records the decisions and their
failure modes.

## 1. Queue: a plain `etl_job` table, no new dependency

Rejected: **pg-boss**. It creates and migrates its own schema (`pgboss.*`) when it starts. S1.10 gives
the app role DML only and the migrator role DDL, and the app must never create tables at boot, so
pg-boss would need a DDL-capable role at runtime or a vendored schema. I did not try to prove it works
with a DML-only role (its install is not designed for that), and a queue this small does not justify it.

Chosen: table `etl_job`, created by a normal drizzle migration, claimed with
`FOR UPDATE SKIP LOCKED`. The app and the worker need only DML.

- One row per requested import: `arc_id`, `kind` (`full` = reset, Extract, Transform, Load;
  `transform` = Transform, Load; `load` = Load), `requested_by`, `state`
  (`queued|running|succeeded|failed`), `current_step`, `attempts`/`max_attempts`, `run_after`,
  `locked_by`, `lease_expires_at`, `error`, timestamps.
- Claim = one statement: pick the oldest job that is `queued` and due, **or** `running` with an
  expired lease, lock it with `SKIP LOCKED`, set `running`, bump `attempts`, set the lease. Two
  claimers can never get the same job.
- Polling (default every 5 s), no LISTEN/NOTIFY: it would not survive PgBouncer transaction pooling.

## 2. Token: run as the importing user's linked account

The job stores only `requested_by` (a user id), never a token. The worker calls better-auth's
`auth.api.getAccessToken({ body: { providerId: 'oidc', accountId, userId } })` with no headers. In the
pinned version (1.6.29) the endpoint accepts `userId` when there is no session, reads the account row,
refreshes the access token against the issuer when it is about to expire, and stores the new tokens.
So refresh logic and token encryption (S2.3) stay in one place. The account row is picked
exactly as in the web app (most recently updated `oidc` row).

The refresh runs under a per-user Postgres advisory lock (`src/lib/server/token-refresh-lock.ts`) shared with the web
app, because GitLab refresh tokens are single use: two refreshes of the same user's token at once would make the loser
fail with `invalid_grant`. Inside the lock better-auth re-reads the account row, so the second caller uses the token the
first just stored and makes no request. The lock is `pg_advisory_xact_lock` in a transaction (safe behind PgBouncer in
transaction mode, released by Postgres if the process dies), it is skipped while the stored token is valid for another
30 s or more, a waiter gives up after 30 s with a transient error (the job is retried, it is not a "sign in again"
failure), and at most half of `DB_POOL_MAX` locks are held or awaited per process so waiting cannot starve the pool
(each held lock uses one connection and the refresh itself a second one). The refresh call is also bounded by
`HTTP_TIMEOUT`.

The worker cannot import `auth.ts` (it uses `$app/server` and the SvelteKit cookie plugin), so it
builds a second better-auth instance from the same shared options, without the cookie plugin.

Failure mode: if the token cannot be obtained (no linked account, refresh token expired or revoked,
issuer unreachable; better-auth reports all of these as one generic error), or GitLab answers 401/403,
the job **fails without retry** with: "PLANTdataHUB access could not be refreshed for the importing user.
Sign in again and retry." Nothing is written: Extract is the only step that needs the token, and it
writes only after a successful download. The token is fetched immediately before Extract. A
`transform`/`load` job needs no token.

The same message is what a user sees after S2.3 (stored tokens cleared by the migration) or a
`BETTER_AUTH_SECRET` rotation until they sign in again: there is no usable refresh token, or it cannot be decrypted.

Rejected: a short-lived token stored on the job. It puts a credential in a second table and still
expires before a queued or retried job runs.

## 3. Concurrency

- **Same ARC.** A partial unique index allows at most one _active_ (`queued` or `running`) job per
  `arc_id`. A second Import click (or another user, or another replica) is **deduplicated**: `enqueue`
  returns the existing active job and the UI says so. It is not queued behind it. This is enforced by
  the database, so it needs no lock and cannot race.
- **Different ARCs** run in parallel, across workers and within one worker (`ETL_CONCURRENCY`, default 1).
- **Zombies.** If a lease expires while the old worker is still alive (paused, DB blip), a second
  worker may reclaim the job. Every job update is fenced on `locked_by` + `attempts`, so the old
  worker's late writes affect nothing and it stops at its next heartbeat. As the last line of defence
  the Load transaction takes `pg_advisory_xact_lock` for the ARC, so two Loads of one ARC can never
  interleave even then. A transaction-scoped lock is used, not `pg_try_advisory_lock`: session locks
  break under PgBouncer transaction pooling (S1.10), because the connection that took the lock may not
  be the one that unlocks it.

## 4. Crash recovery and retries

- A running worker renews `lease_expires_at` every `lease/3` seconds (default lease 60 s). If the pod
  dies, the lease expires and any worker (including the restarted one) reclaims the job; Extract and
  Load are idempotent, so re-running from the start is safe. Nothing stays "running" for longer than
  the lease plus one poll.
- A reclaimed job that has used all attempts is marked `failed` ("worker lost"), and the in-flight step
  in `ro_crate_staging` is set to `failed` with the same text, so the staging row is truthful.
- **Retry policy:** at most `ETL_MAX_ATTEMPTS` (default 3) attempts, with a delay of
  `ETL_RETRY_DELAY_SECONDS x attempt`. Only _transient_ failures retry: network errors, our fetch
  timeouts, HTTP 5xx/429 from PLANTdataHUB, database errors. Everything else (401/403/404, RO-Crate
  parse errors, missing token) fails at once.
- If the very first Extract fails there is no `ro_crate_staging` row (`path` is NOT NULL and only known
  after Extract), so the failure is shown from the `etl_job` row. The schema is unchanged.
- SIGTERM: stop claiming, give running jobs `ETL_SHUTDOWN_TIMEOUT` seconds (default 60); anything still
  running is put back to `queued` (attempt not counted), the pool is closed and the process exits 0.
- No liveness probe in the chart: the worker has no HTTP port. Instead it exits non-zero after 10
  consecutive failed polls (database unreachable), so the kubelet restarts it.

## Timeouts

Every outbound `fetch` goes through `fetchWithTimeout`: a headers timeout (`HTTP_HEADERS_TIMEOUT`,
default 30 s) and an overall timeout including the body (`HTTP_TIMEOUT`, default 300 s). A timeout is a
transient, readable job error. The existing 5 s NCBI timeout is kept (best-effort lookup).

## As implemented

**Files.** Queue: `src/lib/server/etl/queue.ts` (table in `db/schema/staging/etl-job.ts`, migration
`0003_etl_job`). Claim loop: `etl/runner.ts`. Steps: `etl/pipeline.ts` (take a `StepContext`, return
`{ok}` or `{error, transient}`), `etl/execute.ts` (what each job kind runs). Worker entry:
`scripts/worker.ts`, bundled by `pnpm build:worker` (`vite.worker.config.ts` aliases `$lib` and the two
SvelteKit env modules to shims). Token: `etl/worker-auth.ts`, sharing `auth-options.ts` with `auth.ts`.
Timeouts: `fetch-timeout.ts`.

**Job states.** `queued` (waiting, or waiting to retry: `attempts > 0` and `error` set), `running`
(`locked_by`, `lease_expires_at`, `current_step`), `succeeded`, `failed` (`error` is shown on the ARC
page). The ARC page polls `GET /arcs/<id>/job` every 2 s only while the latest job is queued or running.

**Settings.** `ETL_CONCURRENCY` (1), `ETL_LEASE_SECONDS` (60, min 10), `ETL_POLL_SECONDS` (5),
`ETL_MAX_ATTEMPTS` (3), `ETL_RETRY_DELAY_SECONDS` (30), `ETL_SHUTDOWN_TIMEOUT` (60),
`HTTP_HEADERS_TIMEOUT` (30), `HTTP_TIMEOUT` (300). Validated at start-up like the rest
(`env-schema.ts`).

**Small behaviour changes.** A 401/403 on the RO-Crate download is now reported as such (it used to
become a 502), and other 4xx from PLANTdataHUB are no longer reported as 502, so they are not retried.

**Tests.** `queue.test.ts` and `runner.test.ts` run against a real Postgres: set `TEST_DATABASE_URL`
(any URL on a server where you may create databases; each suite creates and drops its own database and
never touches the one in the URL). Without it they are skipped, with a visible placeholder test. CI
has a `postgres:17` service container in `verify`, so they run there.
`pnpm test` locally: `TEST_DATABASE_URL=postgres://root:mysecretpassword@localhost:5432/local pnpm test`
with `docker compose up -d`.

**Verified, and what the stub covered.** With the built image (read-only root, UID 1000, all
capabilities dropped) against a throwaway database and a small HTTP stub standing in for PLANTdataHUB
(OIDC discovery, the `refresh_token` grant, project and RO-Crate endpoints, a generated one-study
RO-Crate): refresh of an expired access token and import; a revoked refresh token fails the job at
once with the "sign in again" message and no staging row; a 75 s download (longer than the 60 s ingress
default) completes; `docker kill` of the worker mid-job leads to a reclaim (attempt 2) and success; a
duplicate request for a running ARC is rejected by the unique index; ARC 90 and 91 run in parallel on
one worker; `docker stop` exits 0 in about 3 s and hands the job back; a killed worker on its last
attempt is reaped as `failed` and `ro_crate_staging` shows the in-flight step failed; the real web
container enqueues in about 30 ms, deduplicates a second click, serves the job endpoint (401 without a
session), renders the status, disables the buttons while a job is active and keeps working across a
web restart.

**Not verified.** Token refresh against a real GitLab (the stub accepts any request shaped like the
refresh grant); a real ARC's import time and memory; the ARC page's polling in a real browser (the
endpoint and server-rendered state were checked, not the client-side timer); the ingress timeout
removal end to end; worker behaviour in a rollout on a real cluster; PgBouncer (the design uses only
transaction-scoped locks and no LISTEN/NOTIFY, but it was not tried).
