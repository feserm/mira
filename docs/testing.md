# Testing the pipeline and the BrAPI read side (S2.10)

This page records the decisions behind the test suite that guards Transform, Load, the ETL worker's
steps and the BrAPI handlers. Run it with `pnpm test` (server project) and a Postgres:

```sh
docker run -d --rm --name mira-test-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=pw postgres:17
TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres pnpm vitest run --project server
docker stop mira-test-pg
```

The role in `TEST_DATABASE_URL` needs `CREATEDB` and `CREATEROLE` (a superuser, as in CI, is simplest).
Each suite creates its own database and roles with unique names and drops them afterwards; it never
touches the database named in the URL.

## 1. Fixtures: generated with ARCtrl, not committed

Decision: sample ARCs are **generated in a test helper** (`src/lib/server/test-support/arc-fixtures.ts`)
with `@nfdi4plants/arctrl` (the library the app itself parses with) and serialised with
`ToROCrateJsonString`. Reasons:

- Reviewable: a fixture is ~60 lines of builder calls, not 5 KB of JSON-LD nobody reads. A diff shows
  _which field_ changed.
- Variants are one parameter (`buildArc({ studyTitle: 'changed' })`, a second ARC that shares a
  contact), which is what the idempotency and sharing tests need.
- Deterministic and contains no real data: every name, e-mail and ORCID is invented
  (`example.org`, ORCID `0000-0001-2345-6789`-style placeholders).
- It exercises what `transform.ts` really reads today: investigation (title, description, dates,
  `License` / `MIAPPE version` comments, a publication), investigation- and study-level contacts (with
  and without ORCID, with and without e-mail, one contact shared by two studies), study comments (site
  name, institution, coordinates, observation-level hierarchy, ...), a plant-growth-protocol table
  (Source -> Sample with Genus/Species characteristics: Germplasm and ObservationUnit), and two studies.

Trade-off accepted: a generated fixture cannot catch a format change that ARCtrl itself makes in
both writer and reader. Real PLANTdataHUB ARCs are not in the repo. A real, anonymised RO-Crate under
`src/lib/server/etl/__fixtures__/` is still wanted as a golden file once someone supplies one (plan
session F lists it as input); the tests take their crate from one function, so adding it is a small
change.

Network: Transform looks up a crop's common name at NCBI. Tests stub `fetch` so no test touches the
network.

## 2. Layers and what each proves

| Layer         | Where                                     | Needs Postgres | Proves                                                                                         |
| ------------- | ----------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| Transform     | `etl/transform.test.ts`                   | no             | RO-Crate in, BrAPI entities out: crosswalk fields, hand-written accessors, missing/malformed   |
| Load          | `etl/load.test.ts`                        | yes            | idempotency, update in place, shared contacts, atomicity, per-ARC serialisation                |
| Pipeline      | `etl/pipeline.test.ts`                    | yes            | queued job -> Extract/Transform/Load with a stubbed GitLab, `ro_crate_staging` stays truthful  |
| BrAPI handler | `src/routes/[repo]/brapi/v2/**/*.test.ts` | yes            | 401, 404, envelope, pagination, filters, sorting, arc isolation, against the real `+server.ts` |
| DML role      | `test-support/dml-db.test.ts`             | yes            | the app role cannot run DDL; the rest of the suite runs as that role                           |

Handlers are called directly with a fake `RequestEvent`. "Who is the caller" lives in one helper
(`test-support/brapi-event.ts`, `authenticatedLocals()`); when sessions G, H and I change how the user is
established, edit that helper.

## 3. Database role: the integration tests run as the DML role

`test-support/dml-db.ts` builds the database the way production does: as a superuser it creates a
migrator role, an app role and a database owned by the migrator; the **drizzle migrator** applies
`./drizzle` as the migrator (the same call as `scripts/migrate.ts`, which cannot be imported because it
exits the process at top level); then `deploy/postgres/sql/roles.sql` runs unchanged apart from role-name
substitution (`mira_migrator`/`mira_dml` get a per-suite suffix so parallel suites and a developer's
real roles do not collide); finally the suite connects as the app role. Any DDL the app or worker
needs at runtime fails the suite. One dedicated test asserts that `CREATE TABLE` is refused.

The older `queue.test.ts` / `runner.test.ts` still use `etl/test-db.ts` (owner role); they were left
alone.

## 4. How the module-level `db` is replaced

`load.ts`, `pipeline.ts`, `extract.ts` and every BrAPI handler import `db` from `$lib/server/db`, which
connects at import time from validated env. Tests replace that module with `vi.mock` (see
`test-support/db-mock.ts`); no production code takes a `db` parameter for the sake of tests.

## 5. CI

`verify` already has a `postgres:17` service and `TEST_DATABASE_URL`. A guard test
(`test-support/ci-guard.test.ts`) fails when `CI` is set and the variable is missing, so the integration
suites cannot be skipped silently. Test-support files are never imported by app code, so they are not in
`pnpm build`, `build:worker` or `build:migrate` output (checked in the session F summary).

## 6. Known gaps (not implemented in the code, so not tested)

`CLAUDE.md` says germplasm, location and observation-unit mapping are missing; that is out of date:
Transform and Load handle Germplasm, Location and ObservationUnit. What is really missing:

- Observations, observation variables, images and events: `transformRoCrate` always returns empty arrays.
- Program: `trial.programId` is never set; `programName` is always null in BrAPI output.
- Seasons, study to observation-variable links, crossing projects, pedigree, seed lots, samples.
- BrAPI endpoints beyond `serverinfo`, `trials`, `studies`, `locations`, `observationunits`,
  `germplasm` and `germplasm/{id}/mcpd` (no `variables`, `observations`, `images`, `events`, ...).
- No test of the web UI (`/arcs`), of token refresh against GitLab, or of PgBouncer.

## 7. Bugs found while writing the tests (each is an `it.fails`, so fixing one turns its test red until `.fails` is removed)

- Investigation submission and public-release dates never reach `datasetAuthorships` (ARCtrl 3.2.0 does not round-trip them through the RO-Crate). `transform.test.ts`
- The NCBI crop-name lookup sends only the species epithet ("mays"), not the binomial. `transform.test.ts`
- A contact imported without an ORCID that later gains one makes Load fail with a duplicate key on `email`. `load.test.ts`
- Load never deletes: a study removed from the ARC stays and is served. Possibly by design. `load.test.ts`
- `/serverinfo` does not list `germplasm` and `germplasm/{id}/mcpd`. `endpoints.test.ts`
- A non-UUID id filter (`?studyDbId=x`) returns a 500. `endpoints.test.ts`

Also: error responses are SvelteKit's `{ message }`, not a BrAPI `metadata.status` envelope (tests pin status
codes only). The `brapi` skill mentioned in CLAUDE.md is not in the repository, so response shapes were
asserted from BrAPI v2.1 as known, and from `src/lib/types/brapi`, not checked against the spec.
