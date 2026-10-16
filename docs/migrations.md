# Database migrations

The app never migrates its own database. Migrations are applied by a separate, short-lived
process that runs **before** the new app version starts: a Kubernetes Job (a Helm
`pre-install,pre-upgrade` hook) or an `initContainer`. Do not run it at app boot: with several
replicas starting at once, every pod would race to apply the same migrations.

## The runner

[scripts/migrate.ts](../scripts/migrate.ts) uses `drizzle-orm/postgres-js/migrator`. It needs no
`drizzle-kit`, no `src/`, and none of the app's env vars (no `ORIGIN`, no auth secrets): it does not
import the app's env module or any SvelteKit module.

| Variable            | Required | Notes                                                                   |
| ------------------- | -------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`      | yes      | `postgres://` or `postgresql://` URL                                    |
| `DB_SSL`            | no       | same values as the app: `true`/`require`/`allow`/`prefer`/`verify-full` |
| `MIGRATIONS_FOLDER` | no       | default `drizzle`, resolved against the working directory               |

Behaviour:

- Applies every migration in `drizzle/` that is not yet recorded in `drizzle.__drizzle_migrations`,
  in one transaction, and prints one `migrate: applied <tag>` line per migration it applied.
- Idempotent: a second run prints `migrate: nothing to apply, N already present` and exits 0.
- Exits 1 on any failure (bad or missing `DATABASE_URL`, connection refused, authentication failure,
  SQL error) after printing the reason to stderr.

## Running it

`pnpm build:migrate` bundles the script with `drizzle-orm` and `postgres` inlined into
`build-migrate/migrate.js`, so it needs no `node_modules`. The Docker image contains it as
`/app/migrate.js` next to `/app/drizzle/`. It must be started **with `/app` as the working
directory** (the image's `WORKDIR`), or with `MIGRATIONS_FOLDER` pointing at the `drizzle/` folder:

```sh
docker run --rm -e DATABASE_URL=postgres://user:pass@host:5432/db IMAGE node migrate.js
```

From a checkout (needs `pnpm build:migrate` first):

```sh
DATABASE_URL=postgres://... node build-migrate/migrate.js
```

In Kubernetes, use the same image as the app with `command: ["node", "migrate.js"]`, the same
`DATABASE_URL` secret, and `restartPolicy: OnFailure` (or `backoffLimit` > 0) for the Job. Give it a
database role that may run DDL; the app role does not need to.

## Adding a migration

Change the schema under `src/lib/server/db/schema/`, run `pnpm db:generate`, and commit the new SQL
file and `drizzle/meta/` changes. The runner picks them up on the next deploy. `pnpm db:push` is for
local development only.
