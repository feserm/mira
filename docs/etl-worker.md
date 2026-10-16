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
So refresh logic and any future token encryption (S2.3) stay in one place. The account row is picked
exactly as in the web app (most recently updated `oidc` row).

The worker cannot import `auth.ts` (it uses `$app/server` and the SvelteKit cookie plugin), so it
builds a second better-auth instance from the same shared options, without the cookie plugin.

Failure mode: if the token cannot be obtained (no linked account, refresh token expired or revoked,
issuer unreachable; better-auth reports all of these as one generic error), or GitLab answers 401/403,
the job **fails without retry** with: "PLANTdataHUB access could not be refreshed for the importing user.
Sign in again and retry." Nothing is written: Extract is the only step that needs the token, and it
writes only after a successful download. The token is fetched immediately before Extract. A
`transform`/`load` job needs no token.

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
