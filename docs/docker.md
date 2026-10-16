# Container image

One image runs both the web app (`node build`, the default `CMD`) and the migration runner
(`node migrate.js`, see [migrations.md](migrations.md)).

## Build

```sh
docker build -t mira:dev .
```

No build arguments and no env vars are needed. The build needs a Docker daemon with network access
(to pull the base image and download packages). It works with the classic builder as well as
BuildKit.

How it is put together ([Dockerfile](../Dockerfile)):

- **Base:** `node:22-bookworm-slim`, pinned by tag _and_ digest (`ARG NODE_IMAGE`). To bump, pull
  the tag and copy the new digest from `docker inspect --format '{{index .RepoDigests 0}}'`.
- **pnpm** comes from corepack, at the version in `packageManager` in `package.json`. Both install
  steps use `--frozen-lockfile`, so the build fails if `pnpm-lock.yaml` is out of date.
- **Stages:** `build` (all dependencies, `pnpm build` and `pnpm build:migrate`), `prod-deps`
  (`pnpm install --prod --ignore-scripts`), `runtime` (copies only `node_modules` from `prod-deps`,
  plus `build/`, `migrate.js`, `drizzle/` and `package.json`).
- **Why a prod `node_modules` at all:** adapter-node leaves everything listed under `dependencies`
  in `package.json` external. That is `@nfdi4plants/arctrl`, `@tabler/icons-svelte-runes` and
  `svelte-grid`. Everything else (including `drizzle-orm`, `postgres` and `better-auth`) is bundled
  into `build/`. The final `node_modules` is therefore small (about 140 MB, mostly arctrl) and has
  no dev tooling (no Playwright, `@better-auth/cli`, drizzle-kit). Anything new added under
  `dependencies` ends up external and in the image; keep build-time libraries in `devDependencies`.
- **Runtime user:** the base image's `node` user, `USER 1000:1000`. Set `runAsUser: 1000` or
  `runAsNonRoot: true` in Kubernetes; the image uses a numeric UID, so both work.
- `NODE_ENV=production`. `CMD` is in exec form, so `node` is PID 1 and gets `SIGTERM` directly.

Listens on `PORT` (default 3000) and `HOST` (default `0.0.0.0`). Required configuration is listed in
[.env.example](../.env.example) and validated at start-up.

## Size

Measured with `docker images`:

| Image      | Size   |
| ---------- | ------ |
| `mira:dev` | 489 MB |

For reference, the pinned `node:22-bookworm-slim` base is about 220 MB of that.

## Read-only root filesystem

The app writes nothing to disk (checked: it starts, serves, and shuts down cleanly with
`--read-only` and **no** tmpfs, and `docker diff` shows no changes). In Kubernetes use
`readOnlyRootFilesystem: true`; an `emptyDir` for `/tmp` is not needed.

## Smoke test

Needs a reachable Postgres that has been migrated (see [migrations.md](migrations.md)). With the
local compose database (`docker compose up -d`) and its default credentials, using the host network
so the container reaches `localhost:5432`:

```sh
# 1. Missing configuration: one error listing every problem, exit code 1
docker run --rm --read-only mira:dev

# 2. Valid configuration
docker run -d --name mira-smoke --read-only --cap-drop ALL --security-opt no-new-privileges \
  --network host -e PORT=3100 \
  -e DATABASE_URL=postgres://root:mysecretpassword@localhost:5432/local \
  -e ORIGIN=https://mira.example.org \
  -e BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef \
  -e OIDC_ISSUER_URL=https://git.example.org \
  -e OIDC_CLIENT_ID=x \
  mira:dev

# The image has no curl; use node's fetch from inside the container
docker exec mira-smoke node -e "fetch('http://127.0.0.1:3100/healthz').then(async r => console.log(r.status, await r.text()))"
docker exec mira-smoke node -e "fetch('http://127.0.0.1:3100/readyz').then(async r => console.log(r.status, await r.text()))"

# 3. Graceful shutdown: should exit 0 within a second or two
time docker stop mira-smoke
docker inspect mira-smoke --format 'exit={{.State.ExitCode}}'
docker rm mira-smoke
```

Expected: `200 ok` from both probes, `exit=0` after `docker stop`, and the log line
`Shutting down (SIGTERM): flushing request logs and closing the database pool`.

## Conventions for the Helm chart

- **Image:** `<registry>/<owner>/mira`, tagged with the full git commit SHA (`mira:<40-hex-sha>`).
  CI also moves a `latest` tag on every push to `main`; do not deploy `latest`, pin the SHA (or the
  digest).
- **App:** default `CMD` (`node build`), working directory `/app`, port 3000, probes `/healthz`
  (liveness) and `/readyz` (readiness).
- **Migrations:** same image, `command: ["node", "migrate.js"]`, working directory `/app` (the image
  default), env `DATABASE_URL` (+ optional `DB_SSL`). Run as a pre-install/pre-upgrade Job or an
  initContainer.
- **Security context:** UID/GID 1000, `readOnlyRootFilesystem: true`,
  `allowPrivilegeEscalation: false`, drop all capabilities.
