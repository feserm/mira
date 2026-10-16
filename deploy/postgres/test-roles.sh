#!/usr/bin/env bash
# Proves sql/roles.sql against a throwaway Postgres 17 in Docker, with the real migration bundle:
# the migrator applies every migration, a second run is a no-op, and the DML-only role can read and
# write everything but cannot create, alter or drop anything. Never touches your own database.
# Needs docker and `pnpm build:migrate`. Run from the repository root:  deploy/postgres/test-roles.sh
set -euo pipefail

name=mira-roles-test-$$
port=$((30000 + RANDOM % 20000))
fail=0
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ -f build-migrate/migrate.js ] || { echo "run pnpm build:migrate first" >&2; exit 1; }
docker run -d --name "$name" -p "127.0.0.1:$port:5432" -e POSTGRES_PASSWORD=su --tmpfs /var/lib/postgresql/data postgres:17 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$name" psql -U postgres -h 127.0.0.1 -Atc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

su() { docker exec -i "$name" psql -v ON_ERROR_STOP=1 -q -U postgres -h 127.0.0.1 "$@"; }
as() { docker exec -i -e PGPASSWORD="$1-pw" "$name" psql -q -At -h 127.0.0.1 -U "$1" -d mira "${@:2}" 2>&1; }

# What CloudNativePG does at bootstrap: the owner role and database first, then the SQL, then the managed role.
su -c "create role mira_migrator login password 'mira_migrator-pw'" -c 'create database mira owner mira_migrator'
su -d mira < deploy/postgres/sql/roles.sql >/dev/null
su -c "create role mira_app login password 'mira_app-pw' in role mira_dml"

url=postgres://mira_migrator:mira_migrator-pw@127.0.0.1:$port/mira
first=$(DATABASE_URL=$url node build-migrate/migrate.js)
second=$(DATABASE_URL=$url node build-migrate/migrate.js)

check() { # description, expected substring, actual
  if [[ "$3" == *"$2"* ]]; then echo "ok   $1"; else echo "FAIL $1 (wanted '$2', got '$3')"; fail=1; fi
}
check "migrator applies migrations" "migrate: done" "$first"
check "second migration run is a no-op" "nothing to apply" "$second"
check "app role cannot CREATE TABLE" "permission denied" "$(as mira_app -c 'create table x(i int)')"
check "app role cannot CREATE TYPE" "permission denied" "$(as mira_app -c "create type t as enum ('a')")"
check "app role cannot ALTER a table" "must be owner" "$(as mira_app -c 'alter table etl_job add column x int')"
check "app role cannot DROP a table" "must be owner" "$(as mira_app -c 'drop table etl_job')"
check "app role cannot read the migration table" "permission denied" "$(as mira_app -c 'select 1 from drizzle.__drizzle_migrations')"
check "app role has DML on every table" "0" "$(as mira_app -c "select count(*) from pg_tables t where schemaname='public' and not (has_table_privilege('mira_app', format('%I.%I', schemaname, tablename), 'SELECT,INSERT,UPDATE,DELETE'))")"
check "app role can claim with FOR UPDATE SKIP LOCKED, advisory lock, gen_random_uuid" "-4" "$(as mira_app -c 'begin; select id from etl_job for update skip locked limit 1; select pg_advisory_xact_lock(1); select gen_random_uuid(); commit;')"
as mira_migrator -c 'create table later_t(id uuid primary key default gen_random_uuid()); create sequence later_s' >/dev/null
check "a table made by a LATER migration is covered" "t|t" "$(as mira_app -c "select has_table_privilege('mira_app','later_t','INSERT'), has_sequence_privilege('mira_app','later_s','USAGE')")"
[ "$fail" = 0 ] && echo "all checks passed" || { echo "some checks FAILED"; exit 1; }
