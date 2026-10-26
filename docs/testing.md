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

| Layer         | Where                                                                                                                          | Needs Postgres | Proves                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Transform     | `etl/transform.test.ts`                                                                                                        | no             | RO-Crate in, BrAPI entities out: crosswalk fields, hand-written accessors, missing/malformed                                                    |
| Load          | `etl/load.test.ts`                                                                                                             | yes            | idempotency, update in place, shared contacts, atomicity, per-ARC serialisation                                                                 |
| Pipeline      | `etl/pipeline.test.ts`                                                                                                         | yes            | queued job -> Extract/Transform/Load with a stubbed GitLab, `ro_crate_staging` stays truthful                                                   |
| BrAPI handler | `src/routes/[repo]/brapi/v2/**/*.test.ts`                                                                                      | yes            | 401, 404, envelope, pagination, filters, sorting, arc isolation, against the real `+server.ts`                                                  |
| DML role      | `test-support/dml-db.test.ts`                                                                                                  | yes            | the app role cannot run DDL; the rest of the suite runs as that role                                                                            |
| ARC access    | `arc-access.test.ts`, `brapi/v2/arc-access.test.ts`, `arcs/[id]/arc-access.test.ts`, the dashboard and `/account/tokens` cases | yes            | S2.4b: who may read an ARC, against a stubbed PLANTdataHUB (`gitlab-stub.ts`); every handler and page entry point is found from the file system |

Handlers are called directly with a fake `RequestEvent`. "Who is the caller" lives in one helper
(`test-support/brapi-event.ts`, `authenticatedLocals()`); when sessions G, H and I change how the user is
established, edit that helper. Since S2.4 `callBrapi` also takes request `headers` (`bearer(token)`) and returns the
headers the handler set and the final `locals`; API-token callers are tested in `brapi/v2/auth.test.ts`. Since S2.2 it takes a role (`authenticatedLocals(userId, 'admin')`, default `'user'`).

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

## 7. Bugs found while writing the tests

Five of the six were fixed after the first green CI run; the decisions are recorded here.

- **Open, accepted:** investigation submission and public-release dates never reach `datasetAuthorships`. ARCtrl 3.2.0 does not round-trip them through the RO-Crate, so this is an upstream limitation. The `it.fails` in `transform.test.ts` stays as a tripwire: when an ARCtrl upgrade fixes it, the test goes red and `.fails` comes off.
- **Fixed:** the NCBI crop-name lookup sends the binomial (genus + species) instead of the species epithet. `transform.test.ts`
- **Fixed:** a contact that gains an ORCID between imports updates its email row instead of failing with a duplicate key. A contact that only gains an email after being identified by name + institute is not covered. `load.test.ts`
- **Fixed (by decision):** Load prunes. After the upserts it deletes the ARC's studies, observation units, observations, images and events that are no longer in the ARC, and the trial and study contact links that are gone. Contacts, locations and germplasm are shared and never deleted. `load.test.ts`
- **Fixed:** `/serverinfo` lists `germplasm` and `germplasm/{germplasmDbId}/mcpd`; a test derives the expected list from the route directories. `endpoints.test.ts`
- **Fixed:** a `*DbId` filter that is not a UUID returns an empty page (`hasMalformedDbId` in `response.ts`), and a non-UUID `germplasmDbId` on the mcpd route is a 404, instead of a 500. `endpoints.test.ts`

## 8. Golden fixture: a real RO-Crate

`src/lib/server/test-support/fixtures/phenosphere-ro-crate.json` is the IPK Phenosphere maize benchmark ARC (4380 graph nodes, 7 studies, 11 accessions, 1035 observation units). The e-mail addresses and ORCIDs of its two registered contacts are replaced by placeholders; everything else is as exported, and a test fails if a real address comes back. `etl/golden.test.ts` transforms it (about 4 s, so the tests share one run) and, against Postgres, loads it, re-imports it with unchanged counts and row ids, and prunes a removed study.

Not covered by this crate: observations, observation variables, images and events (Transform emits none from it yet).

## 9. ARC access (S2.4b)

Every suite that reaches a BrAPI handler, an `/arcs/[id]` entry point or the dashboard loader goes through `checkArcAccess`, which asks PLANTdataHUB. Tests therefore need two things beyond the database:

- `vi.mock('$lib/server/env', async () => (await import('$lib/server/test-support/env-mock')).envModule)`: the issuer is `https://gitlab.test` and the timeouts are short (1 s and 2 s), so the test of a hanging GitLab is quick.
- `stubGitlab()` (`test-support/gitlab-stub.ts`), which stands in for the OIDC endpoints and for `GET /api/v4/projects/:id`. Suites that are not about access use `stubGitlab({ unknownProjects: 'public' })`: every ARC is public and nobody needs a login. Suites about access register projects with `setProject(id, { visibility, members })` (members are access tokens), accept tokens with `acceptToken`, and break GitLab with `failProjects(status | 'network' | 'hang')`; `projectCalls()` records who asked (token or anonymous). `seedOidcLogin` (`test-support/oidc-seed.ts`) stores a user's encrypted login the way a real sign-in does.
- The answers are cached in process: call `resetArcAccessCache()` in `beforeEach`, and use `vi.useFakeTimers({ toFake: ['Date'] })` to move past the TTL.

The stub encodes what the access check relies on (anonymous callers see only public projects, an unknown token is a 401, internal projects need any known token, private ones a member). It is **not** evidence that real PLANTdataHUB behaves so: see the S2.4b list in the sprint plan.
