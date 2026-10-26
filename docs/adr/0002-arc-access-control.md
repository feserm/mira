# 0002: Per-ARC access control on PLANTdataHUB

Status: accepted (session I, sprint story S2.4b). Date: 2026-10-26.

## Context

MIRA re-exposes data that lives in PLANTdataHUB (GitLab) projects, and the sprint plan decided that **only users with GitLab access to an ARC may read it** ([sprint plan](../deployment-sprint-plan.md), decision 1). Until S2.4b, any signed-in user, or any holder of an API token, could read every imported ARC through BrAPI, the `/arcs/[id]` pages (staging row, raw RO-Crate, job state) and the dashboard (ARC list and table counts). The data is keyed by `arc_id`, which is the GitLab project id (`extract.ts` fetches `projects/{arcId}`); that is what the check uses.

Three facts shape the design:

- An ARC can turn private, or a member can be removed, **after** the import. So nothing stored at import time can be trusted ("stored visibility").
- An API token has no GitLab credentials. It identifies its owner ([ADR 0001](0001-api-tokens.md)), and the owner's stored, encrypted OIDC login is what talks to GitLab for them.
- The check couples BrAPI latency to GitLab availability (plan risk 2).

## Decision

**Every BrAPI request and every ARC page asks PLANTdataHUB whether the caller can read the ARC, through one function with a short in-process cache.** Public ARCs too (user decision).

### The check (`src/lib/server/arc-access.ts`)

`checkArcAccess(userId, arcId)` answers one of four things.

1. **Anonymous first.** `GET /api/v4/projects/{id}` with no credentials. A `200` whose body has `id == arcId` and `visibility == "public"` is **allow**. A public ARC then needs nobody's login, so it keeps working when the owner's login is dead.
2. **The caller's own login.** Otherwise the stored OIDC account of `userId` is used: for a session request the signed-in user, for a token request the token owner (both are `locals.user.id`; `locals.authMethod` plays no part). The access token comes from `getWorkerAccessToken(userId)`, the same function the ETL worker uses: **one** refresh path, under the per-user advisory lock of session G. Then `GET /api/v4/projects/{id}` with that bearer token.
3. **Which GitLab answer means "can read".**

   | GitLab answer                                                                                                | Meaning                                                           | Result         |
   | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------- |
   | anonymous `200`, `visibility: public`                                                                        | anyone may read it                                                | allow          |
   | authenticated `200`, `id` equals the ARC id                                                                  | GitLab shows the project to this user                             | allow          |
   | authenticated `404` or `403`                                                                                 | no such project for them (GitLab hides private projects with 404) | deny           |
   | authenticated `401`; no linked account; refresh refused                                                      | their login no longer works                                       | unusable-login |
   | `5xx`, `429`, timeout, network error, a redirect, unreadable body, a lock wait that timed out, any exception | cannot tell                                                       | unavailable    |

   An authenticated `200` is "can read" because GitLab only returns a project the user may see: public (anyone), **internal** (any signed-in user; GitLab hides it from external users), **private** (members only, including members through a group). This is the same visibility the ARC pages already rely on when they fetch the project as the user. Redirects are never followed (`redirect: 'manual'`): with public access restricted GitLab redirects an anonymous call to its sign-in page, and that HTML must not read as an answer.

   Known edge, **to verify on staging**: a _Guest_ of a private project can see the project but not its repository. We treat a visible project as readable and do not look at `permissions.project_access`, because that field omits access that comes through a group share and would wrongly deny those users. If Guests must be excluded, that is a stricter rule on the same response.

4. **Fail closed.** `unavailable` and `unusable-login` never return data.

### Responses (`accessFailure`, the one mapping)

| Situation                                              | BrAPI                                                      | ARC pages                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| No access / project not visible to the caller          | **404**, exactly the body of an unknown repo               | **404** `Not found on PLANTdataHUB`, as for an id that is not a project |
| Login unusable (no oidc account, refresh refused, 401) | **403**, BrAPI error envelope, "Sign in to MIRA again ..." | 403, same message                                                       |
| GitLab unreachable, timeout, 5xx, 429                  | **503** with `Retry-After`, no data                        | 503 with `Retry-After`                                                  |

A denied caller cannot tell an ARC they may not read from one that does not exist, **except by timing**: a known ARC costs a GitLab round trip on a cold cache and an unknown one does not. Not closed here; the ARC list on PLANTdataHUB is not secret to a user who can search it, and the cache makes the difference one request wide.

### Cache

- **5 minutes** for allow and deny (`ACCESS_CACHE_TTL_MS`), **5 seconds** for unusable-login and unavailable (`ACCESS_FAILURE_TTL_MS`). Constants, not environment variables.
- In process memory, **per pod**, no database. Keyed by `(user id, ARC id)`: one user's answer never serves another, and a session call and a token call of the same user share the answer.
- The TTL runs from the moment the question was asked, so a revoked grant, or a public ARC turned private, is visible to a user who read it a moment earlier for **at most 5 minutes**. A newly granted user waits as long.
- Concurrent requests for one key share one in-flight GitLab call. A remembered failure is returned with the time left, so a burst does not hammer a GitLab that is down.
- The map is swept of expired entries above 10 000 keys. Failures are never cached long: a recovery (GitLab back, the user signed in again) shows within seconds.
- With N replicas each pod asks on its own: GitLab sees up to N times the calls, and a revocation reaches every pod within the TTL, not at the same moment.

### Where it is called

- **BrAPI:** `resolveReadableArc(event)` (`brapi/arc.ts`) is the second line of every handler, after `authenticateBrapi(event)`. It resolves `[repo]` (unknown: 404) and then checks. A test lists the handlers from the file system and runs each as a denied caller, so a new endpoint that skips it fails CI.
- **ARC pages:** `requireArcPageAccess(event)` (`arc-page-access.ts`) starts the `/arcs/[id]` load, its three actions, the job poll and the RO-Crate download. The last two served MIRA's own tables to any signed-in user before. Same file-system test. The `/arcs` list needs nothing: it asks GitLab as the user and GitLab filters.
- **Dashboard:** the ARC list and the table counts cover only ARCs the viewer can read (`dashboard-access.ts`). It runs the same `checkArcAccess` for every imported ARC (shared cache, bounded concurrency of 6). There is no separate listing call: one check per ARC keeps a single definition of "can read", at the price of up to two GitLab calls per ARC on a cold cache and none on a warm one. An ARC that could not be checked is **left out** and a notice says why; nothing is counted from stored data. `?server=<arc>` for an ARC the viewer cannot read is ignored. Shared tables (germplasm, locations, programs, seasons, observation variables) count only rows an accessible ARC references, the same membership the BrAPI list endpoints use; tables that cannot be attributed to an ARC today (breeding methods, traits, methods, scales, ontologies, lists, people, germplasm attributes) are no longer shown, because a global count would include inaccessible ARCs. Request metrics are unchanged: the endpoint widget groups by route pattern with the repo slug stripped (tested), but its totals include traffic to ARCs the viewer cannot read.
- **`/account/tokens`:** shows "sign in again" when the owner's login cannot be used (computed at page load, only for someone with an active token).

### GitLab calls

| Where                                   | Cold cache                                                                                                                                | Warm cache |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A BrAPI request or ARC page, public ARC | 1 (anonymous)                                                                                                                             | 0          |
| ... private or internal ARC             | 2 (anonymous, then the caller's), plus a `POST /oauth/token` if the access token is within 30 s of expiry (once per user, under the lock) | 0          |
| Dashboard load                          | that, per imported ARC, at most 6 at a time                                                                                               | 0          |

### Contacts (plan risk 4): accepted

Contacts are shared rows, deduplicated globally by ORCID, e-mail or name and institute. They are **only returned through an ARC the caller may read** (`trials` joins `contact` through `trial_contact` of that ARC) and are never listed globally, so a contact reaches a caller only together with an ARC they can read. What a caller can learn is that a person on a readable ARC is the same row as one on another ARC (the `contactDbId` is the same). Accepted.

### Admin

Admin is an operations role (plan decision 1) and gets **no extra ARC access**: an admin is checked like anyone else.

### If GitLab refresh tokens expire too soon (not implemented)

If staging shows that refresh tokens die often enough to break token callers, the fallback is to check only ARCs that are not public and serve public and internal ones without the owner's login. _Whether an ARC needs a check_ is the one small function `arcNeedsCheck` in `arc-access.ts`; the change is a few lines there, plus a visibility known without the owner's login (for example stored at import, which is the "stored visibility" alternative below, so that would reintroduce its staleness for the unchecked ARCs).

## Alternatives considered

- **Private ARCs only.** Cheaper, but an ARC can turn private after import, and then the stored value is wrong in the dangerous direction. The user chose to check every ARC. (It stays the documented fallback.)
- **Stored visibility** (record `visibility` at import and decide from it). One column and no GitLab call, but it is stale the moment a project changes visibility or a member leaves, and it says nothing about _who_ may read a private or internal ARC.
- **Importer-managed ACL** (the user who imports an ARC owns a list of MIRA users who may read it). Full control and no GitLab dependency at request time, but it is a second source of truth that drifts from GitLab membership, needs a UI, and contradicts decision 1 (access is GitLab's).
- **One listing call per viewer** (`GET /projects?membership=...`) for the dashboard. Fewer calls on a cold cache, but it needs paging through every project the viewer can see, and it would be a second definition of "can read".
- **Check only on cache miss in a shared cache (Postgres/Redis).** Revocation would be seen by every pod at once, but adds a table or a service and a write per request. The user chose per pod, in process.

## Consequences

- BrAPI latency depends on GitLab for the first request per user and ARC every 5 minutes per pod. GitLab down: those requests are 503 (fail closed); cached allows keep working until they expire.
- A token stops working for non-public ARCs when its owner's refresh token dies, with a 403 that says to sign in again, and `/account/tokens` says so too.
- A user removed from an ARC can keep reading it for up to 5 minutes (per pod).
- ARC pages and the dashboard make the same calls, so a user with many ARCs on a cold cache makes up to two calls per ARC on the first dashboard load.

## What the write (POST) iteration needs to know

Import rights (finding H9) are **not** decided here: today any user who can read an ARC may queue its import. The check is read access only; `checkArcAccess` answers "may this user see the project", not "may they change it". The next BrAPI iteration adds POST endpoints and must decide:

- the GitLab role that allows writing (Developer or higher on the project, from `permissions.project_access` or the group access, or an own role in MIRA), and whether import is that role too;
- whether a write needs a **fresh** check (not the 5 minute cache), since a revoked writer should stop at once;
- token scopes: tokens are read-only today and have no scope field (ADR 0001); a write token needs one;
- the check answers per `(user, ARC)` for reading; a write permission needs its own cache key or no cache.
