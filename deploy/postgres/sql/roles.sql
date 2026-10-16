-- Role model for MIRA (S1.10). Run as a superuser, connected to the application database, once the
-- database exists and is owned by the migrator role `mira_migrator`.
--
--   mira_migrator  owns the database and every object in it (it runs `node migrate.js`).
--   mira_dml       NOLOGIN group role: the privileges the app and the ETL worker need.
--   mira_app       LOGIN role, member of mira_dml (created by Cluster spec.managed.roles, see
--                  cluster.yaml). No DDL: it cannot create, alter or drop anything.
--
-- ALTER DEFAULT PRIVILEGES FOR ROLE mira_migrator makes every table and sequence a *future*
-- migration creates readable and writable for mira_dml, so a new migration needs no new GRANT.
-- This only works because mira_migrator creates the objects: default privileges apply to the role
-- named in FOR ROLE. If a table is ever created by another role, re-run the two GRANT ... ALL
-- statements below as that role's owner.
--
-- What the code needs, checked against src/ and drizzle/:
--   * SELECT/INSERT/UPDATE/DELETE on all tables (including `etl_job`, claimed with
--     SELECT ... FOR UPDATE SKIP LOCKED, which needs UPDATE).
--   * No sequences are used today (all keys are `uuid DEFAULT gen_random_uuid()`, a built-in since
--     PostgreSQL 13 that needs no privilege or extension); USAGE on sequences is granted anyway so
--     a future serial/identity column does not break inserts.
--   * pg_advisory_xact_lock: no privilege needed.
--   * Enum types: USAGE is granted to PUBLIC by default, so they need no grant.
--   * No TRUNCATE, no temp tables, no CREATE, no LISTEN/NOTIFY.
-- The schema `drizzle` (migration bookkeeping) is deliberately not granted: the app never reads it.

CREATE ROLE mira_dml NOLOGIN;

-- PostgreSQL 15+ already withholds CREATE on `public` from PUBLIC; state it so it also holds on
-- clusters that were upgraded from older versions.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mira_dml;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mira_dml;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mira_dml;

ALTER DEFAULT PRIVILEGES FOR ROLE mira_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mira_dml;
ALTER DEFAULT PRIVILEGES FOR ROLE mira_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mira_dml;
