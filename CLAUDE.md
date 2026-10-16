# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Configuration

- **Language**: TypeScript
- **Package Manager**: pnpm
- **Add-ons**: prettier, eslint, tailwindcss, drizzle, mcp, vitest, sveltekit-adapter

## Commands

```sh
pnpm dev                 # start dev server
pnpm check               # svelte-kit sync + svelte-check (type checking)
pnpm lint                # prettier --check + eslint
pnpm format              # prettier --write
pnpm test                # vitest run (client + server projects, single run)
pnpm test:unit           # vitest in watch mode
pnpm test:unit -- --run path/to/file.test.ts   # run a single test file

pnpm db:start            # docker compose up (local Postgres)
pnpm db:push             # push schema changes directly (dev)
pnpm db:generate         # generate a drizzle migration from schema changes
pnpm db:migrate          # apply migrations
pnpm db:studio           # drizzle studio
pnpm auth:schema         # regenerate src/lib/server/db/schema/auth/schema.ts from auth.ts config
```

Vitest has two projects (see `vite.config.ts`): `client` runs `*.svelte.{test,spec}.ts` in a real
Chromium instance via `@vitest/browser-playwright`; `server` runs everything else under `src/lib/server/**`
(and other non-Svelte tests) in Node. `expect: { requireAssertions: true }` is set globally — every
test must contain an assertion.

Requires a running Postgres (`pnpm db:start`) and a populated `.env` (see `.env.example`) for any
server-side work — `db:push`/migrations, auth, and most of `src/lib/server/**`.

## Architecture

This app (MIRA) is a **BrAPI (Breeding API) server** that re-exposes plant-breeding experiment data
stored in **PLANTdataHUB ARCs** (Annotated Research Contexts — ISA-Tab/RO-Crate-based datasets hosted
as GitLab projects). It is not a general breeding database with its own primary data entry; the
source of truth is an externally-authored RO-Crate, and this app imports it via ETL, then serves it
back out through the standard BrAPI HTTP interface.

### Auth and PLANTdataHUB access

Auth is [better-auth](https://better-auth.com) (`src/lib/server/auth.ts`), configured with the generic
OAuth plugin against an OIDC provider. **The OIDC issuer _is_ the PLANTdataHUB GitLab instance** —
logging in via OIDC produces a GitLab OAuth access token (stored as a better-auth `account` row with
`providerId: 'oidc'`), which is reused directly against GitLab's REST API (`/api/v4/...`) to list/fetch
ARCs and download RO-Crate metadata. This dual use is why `src/lib/server/plantdatahub.ts` has its own
`getAccessToken()` that looks up the _most recently linked_ oidc account row explicitly, rather than
trusting better-auth's own lookup — a user can accumulate more than one oidc account row across logins.

`src/hooks.server.ts` wraps every request through better-auth's `svelteKitHandler`, and additionally
logs request metrics (endpoint, method, status, response time) for any request matching
`/[repo]/brapi/v2/...`, via a batched async queue (`src/lib/server/db/request-logs.ts`) so logging
never blocks the response.

### ETL pipeline: Extract → Transform → Load

`src/lib/server/etl/pipeline.ts` orchestrates three independently-retryable steps per ARC, tracked in
the `ro_crate_staging` table (`src/lib/server/db/schema/staging/schema.ts`) keyed by `arcId`, each with
its own `pending|success|failed` status/timestamp/error columns:

1. **Extract** (`extract.ts`) — fetches the ARC's `arc-ro-crate-metadata.json` package from
   PLANTdataHUB (GitLab generic package registry) and the GitLab project's `path`, storing the raw
   JSON-LD in `ro_crate_staging.raw_ro_crate`.
2. **Transform** (`transform.ts`) — parses the staged RO-Crate via `@nfdi4plants/arctrl`
   (`ARC.fromROCrateJsonString`) into ISA objects, then maps ISA → BrAPI entities. This mapping is
   **not hardcoded field-by-field**; it's driven by an SSSOM mapping set (`sssom.tsv`, generated from
   the MIAPPE LinkML schema) with **MIAPPE as the pivot** — an ISA field and a BrAPI field are only
   ever related through sharing a MIAPPE subject id, never mapped directly onto each other. Only
   fields whose _structure_ (not just naming) differs between ISA and BrAPI bypass the crosswalk and
   are handled as named accessor/setter functions instead. Read the large comment block at the top of
   `transform.ts` before touching this file — it explains the registry-keying rationale in detail.
   Study-level MIAPPE fields aren't in `sssom.tsv` yet and are still read by hand (comment-name lookup
   on the ISA study); germplasm/location/program/observation mapping is not yet implemented.
3. **Load** (`load.ts`) — upserts the transform result into the arc-scoped BrAPI tables inside one
   transaction, keyed on `(arc_id, source_id)` via a generic `upsertArcScoped` helper built from
   Drizzle's `onConflictDoUpdate`. Contacts are the one _shared_ (non-arc-scoped) entity and dedupe
   globally by ORCID → email → (name, institute), one at a time, since a batched upsert has no
   reliable way to correlate returned rows back to input rows when multiple contacts share no
   identifier.

Each step can be re-run independently (`resetDownstream` clears transform/load status so a step can be
retried without re-extracting), and the pipeline is invoked per-ARC from `src/routes/arcs/[id]/`.

### BrAPI HTTP surface

Routes under `src/routes/[repo]/brapi/v2/...` implement the BrAPI REST spec. `[repo]` is the ARC's
GitLab project path (URL slug, not a numeric id); `resolveArcId()` (`src/lib/server/brapi/arc.ts`)
resolves it case-insensitively to the internal `arcId` used to scope every query, via
`ro_crate_staging.path` (populated at Extract time, not looked up live against GitLab per request).
`src/lib/server/brapi/response.ts` provides the shared response envelope (`brapiListResponse`/
`brapiSingleResponse`), pagination parsing, and the `brapiJson` helper — every BrAPI endpoint should
use these rather than hand-rolling the envelope. Use the `brapi` skill (`.claude/skills/brapi/`) to
look up BrAPI endpoint/schema details offline instead of fetching the spec — it has indexed line
numbers into the full v2.1 OpenAPI spec.

### Database schema

Drizzle schema lives under `src/lib/server/db/schema/`, grouped by domain and re-exported from
`schema/index.ts`:

- `auth/` — better-auth's own tables (regenerate via `pnpm auth:schema`, don't hand-edit)
- `staging/` — `ro_crate_staging`, the ETL tracking table described above
- `brapi/core.ts`, `brapi/germplasm.ts`, `brapi/phenotyping.ts` — the BrAPI data model itself
  (Trial, Study, Contact, Program, Germplasm, ObservationUnit, Observation, etc.)
- `dashboard.ts`, `logging.ts` — internal analytics/request-logging tables, unrelated to BrAPI

BrAPI entity tables are **arc-scoped**: they carry both `arcId` and `sourceId` (the ISA identifier),
unique together, so the same logical entity re-imported from a re-extracted ARC upserts in place.
`src/lib/types/brapi/*` holds the corresponding TypeScript request/response/`NewX` insert types,
separate from the Drizzle table definitions.

### Frontend

SvelteKit routes render an ARC browser (`/arcs`, `/arcs/[id]`) on top of the same GitLab/PLANTdataHUB
API, plus an internal analytics dashboard (`src/lib/components/dashboard/`) backed by
`request-analytics.ts`/`brapi-analytics.ts`. All Svelte components are runes mode (forced via
`vite.config.ts`'s `compilerOptions.runes`, project-wide except `node_modules`). Use the Svelte MCP
tools (`list-sections` → `get-documentation` → `svelte-autofixer`) per the instructions below whenever
writing or editing Svelte code.

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.
