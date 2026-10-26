# 0001: API tokens for BrAPI clients

Status: accepted (session H, sprint story S2.4). Date: 2026-10-26.

## Context

BrAPI clients (scripts, notebooks, BMS, Breedbase tools) have no browser session, but every BrAPI handler required the better-auth session cookie (finding H4). The team decided on **per-user API tokens** ([sprint plan](../deployment-sprint-plan.md), decision 2). Who may see which ARC is decided by GitLab access, enforced later per request (S2.4b, decision 1), and for a token request it is checked against the **token owner's** linked GitLab account. So a token must identify its owner and nothing more.

## Decision

**An own table, `api_token`, hashed, with a small helper in the web app.**

- **Format:** `mira_` plus 32 random bytes as base64url (43 characters, 256 bits). Shown once at creation.
- **Storage:** only `sha256(token)` (hex, unique) and the first 8 characters (`prefix`, to tell tokens apart in the UI). A fast hash is right for a random 256-bit secret: there is nothing to brute-force, and a slow hash would only cost latency on every API call. The lookup is by hash; the stored and computed hashes are then compared with `timingSafeEqual`.
- **Columns:** `id`, `user_id` (FK `user`, on delete cascade), `name`, `token_hash`, `prefix`, `created_at`, `expires_at`, `last_used_at`, `revoked_at` (migration `0006`). The app role gets DML through the default privileges, so no grant is needed.
- **Scopes:** none. BrAPI here is read-only, so every token is read-only. There is no per-ARC scoping: a token reaches what its owner reaches (S2.4b).
- **Expiry:** 90 days by default; 30, 90 or 365 days, or "never" only as an explicit choice. At most 25 active tokens per user.
- **One helper:** `authenticateBrapi(event)` (`src/lib/server/brapi/auth.ts`) starts every BrAPI handler. It takes `Authorization: Bearer <token>` or the session cookie and returns the user, or throws 401. A bearer header that is present but not a valid, active token (malformed, unknown, revoked, expired, owner banned) is a 401 **even when a valid cookie is sent**: the cookie is never a fallback. 401s carry `WWW-Authenticate: Bearer` and the BrAPI error envelope (`metadata.status`); the response never echoes the token and does not say which check failed.
- **Caller identity:** on success `locals.user` is the caller and `locals.authMethod` is `'session'` or `'token'` (typed in `app.d.ts`). S2.4b reads `locals.user.id` the same way for both.
- **Last use:** `last_used_at` is written at most once per 5 minutes per token, fire and forget, after the response is decided. A failed write is logged (token id and error message, never the token or hash) and does not affect the request.
- **Management:** `/account/tokens` (form actions: create, revoke; the list is in `load`). Session cookie only: a request carrying an `Authorization` header is refused there, so a token cannot create or revoke tokens. Revoking someone else's token is a 404; admins have no access to other users' tokens (admin is an operations role). Revoking sets `revoked_at`; the row stays, so the list shows the history.
- **Rate limit:** 60 requests per minute per token id, 429 with `Retry-After`, in an in-process fixed-window counter (`rate-limit.ts`, no database). It applies to token requests only. It is **per pod**: with N replicas a token can make up to N times the limit. Ingress rate limiting and better-auth's own limiter belong to S2.7 (session K). The limits are constants (`TOKEN_RATE_LIMIT`), not environment variables.
- **No limit on failed attempts.** A failure limiter would have to be keyed by client address. The chart leaves `ADDRESS_HEADER` unset on purpose, and then adapter-node's `getClientAddress()` returns the socket peer, which behind the ingress is the ingress pod: every client would share one key, so a few bad requests would lock everyone out. Guessing a 256-bit token is not feasible, and an invalid token costs one indexed lookup. Revisit with S2.7 once the ingress forwards a trusted client address. _Revisited in session K (ADR 0004, `docs/rate-limits.md` section 4): a trustworthy address now exists, and failed attempts are still not limited, because a lock-out by address would also lock out colleagues' valid tokens behind a shared institute address._
- **`serverinfo`:** BrAPI 2.1's `ServerInfo` has no field for the authentication method, so `/serverinfo` states it in `serverDescription` (bearer token, or session cookie, and the rate limit) and points `documentationURL` to `/account/tokens`. The machine-readable signal is `WWW-Authenticate: Bearer` on a 401. Note that `/serverinfo` itself needs authentication, as before.
- **Web only.** The token code is not imported by `auth-options.ts`, which the ETL worker bundles (it cannot import `$app/*`). `hooks.server.ts` is unchanged.

## Alternatives considered

**better-auth's API key plugin** (`@better-auth/api-key` 1.6.29, read from the published package; it is a separate package and is not installed here):

- It hashes keys with SHA-256 by default, supports expiry, a key prefix, per-key rate limits and `verifyApiKey` on the server without a session, so it could do most of this.
- Against: it adds a dependency and an `apikey` table to the better-auth schema (regenerated with `pnpm auth:schema`, never edited by hand), which `auth-options.ts` would have to load and so would end up in the worker bundle. It ships its own HTTP routes (`/api-key/create`, `get`, `list`, `update`, `delete`, ...) that would have to be switched off with `disabledPaths` as for the admin plugin, or reviewed one by one. Its rate limit is database backed (per-key columns, updated on verification), whereas we want a database-free limiter now and S2.7 to decide the shared one. It has an `enabled` flag and a delete endpoint, but no revocation time, so the UI could not show when a token was revoked. We need the token's owner id at one point only (S2.4b), which a 60-line table gives equally well. Fewer moving parts and no new dependency won over reuse.
- Neither option blocks S2.4b: both give the owner's user id.

**OIDC bearer validation** (accept GitLab access tokens directly): clients would need GitLab OAuth, tokens are short-lived, and every request would call GitLab. Rejected in the sprint plan.

**Public read access:** contradicts decision 1.

## Consequences

- A non-browser client can call `/{repo}/brapi/v2/...` with `Authorization: Bearer <token>`.
- A leaked token is read access to everything its owner can read until it is revoked or expires. There is no scope to narrow it. The owner sees `last_used_at` and can revoke at once.
- A database dump contains hashes, not tokens.
- The limiter is per pod and forgets on restart; it protects the app from one runaway client, not from a distributed attack.
- Banning a user stops their tokens (checked on use). Deleting a user deletes their tokens.

## What S2.4b needs from this

- After `authenticateBrapi(event)`, `locals.user.id` is the identity to check against GitLab, for both token and session callers; `locals.authMethod` says which. For a token call, the owner's `oidc` account must stay refreshable, and the failure (expired refresh token) must be a 403, not a silent pass.
- The helper does no GitLab check. Put the ARC access check after it, in the same place for every handler (or inside `resolveArcId`'s callers).
- The dashboard's ARC list and table counts are still visible to every signed-in user; S2.4b must make them respect GitLab access.
- Contacts are shared rows, unchanged by this decision.
