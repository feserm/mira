/** A throwaway Postgres database set up the way production is (docs/testing.md section 3):
 *  1. as a superuser: a migrator role, an app role and a database owned by the migrator;
 *  2. as the migrator: the real drizzle migrations from ./drizzle;
 *  3. as the superuser: deploy/postgres/sql/roles.sql (role names suffixed per suite);
 *  4. the suite then connects as the app role, which has DML only.
 *  Needs TEST_DATABASE_URL with CREATEDB and CREATEROLE. Never touches the database named in the URL. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from '$lib/server/db/schema';
import { hasTestDb, testDbUrl } from '$lib/server/etl/test-db';

export { hasTestDb };

export type AppDb = PostgresJsDatabase<typeof schema>;

export interface DmlTestDb {
	/** connected as the DML-only app role: what the web app and the worker use */
	db: AppDb;
	client: postgres.Sql;
	/** URL of the database for the app role */
	url: string;
	/** an existing `user` row, for foreign keys such as `requested_by` */
	userId: string;
	/** the unique role names created for this suite */
	roles: { migrator: string; dml: string; app: string };
	drop(): Promise<void>;
}

const rolesSql = () => readFileSync('deploy/postgres/sql/roles.sql', 'utf8');

function urlFor(base: string, user: string, password: string, database: string) {
	const url = new URL(base);
	url.username = user;
	url.password = password;
	url.pathname = `/${database}`;
	return url.toString();
}

export async function createDmlTestDb(): Promise<DmlTestDb> {
	if (!testDbUrl) throw new Error('TEST_DATABASE_URL is not set');
	const id = randomUUID().replace(/-/g, '').slice(0, 16);
	const database = `mira_test_${id}`;
	const roles = {
		migrator: `mira_t${id}_migrator`,
		dml: `mira_t${id}_dml`,
		app: `mira_t${id}_app`
	};
	const password = randomUUID();

	const admin = postgres(testDbUrl, { max: 1, onnotice: () => {} });
	await admin.unsafe(`create role ${roles.migrator} login password '${password}'`);
	await admin.unsafe(`create role ${roles.app} login password '${password}'`);
	await admin.unsafe(`create database ${database} owner ${roles.migrator}`);

	// The same call scripts/migrate.ts makes (that script exits the process, so it cannot be imported).
	const migratorClient = postgres(urlFor(testDbUrl, roles.migrator, password, database), {
		max: 1,
		onnotice: () => {}
	});
	await migrate(drizzle(migratorClient), { migrationsFolder: 'drizzle' });
	await migratorClient.end({ timeout: 5 });

	// roles.sql with the production role names mapped to this suite's names. Fail loudly if the
	// substitution ever stops matching, so the test cannot silently run without the grants.
	const substituted = rolesSql()
		.replace(/\bmira_migrator\b/g, roles.migrator)
		.replace(/\bmira_dml\b/g, roles.dml);
	if (!substituted.includes(`CREATE ROLE ${roles.dml} NOLOGIN`))
		throw new Error('roles.sql no longer matches the substitution in dml-db.ts');
	const inDb = new URL(testDbUrl);
	inDb.pathname = `/${database}`;
	const superuserInDb = postgres(inDb.toString(), { max: 1, onnotice: () => {} });
	await superuserInDb.unsafe(substituted);
	await superuserInDb.unsafe(`grant ${roles.dml} to ${roles.app}`);
	await superuserInDb.end({ timeout: 5 });

	const url = urlFor(testDbUrl, roles.app, password, database);
	const client = postgres(url, { max: 20, onnotice: () => {} });
	const db = drizzle(client, { schema });

	const userId = `u-${randomUUID()}`;
	await db.insert(schema.user).values({ id: userId, name: 'Test', email: `${userId}@example.org` });

	return {
		db,
		client,
		url,
		userId,
		roles,
		async drop() {
			await client.end({ timeout: 5 });
			await admin.unsafe(`drop database if exists ${database} with (force)`);
			for (const role of [roles.app, roles.dml, roles.migrator]) {
				await admin.unsafe(`drop role if exists ${role}`);
			}
			await admin.end({ timeout: 5 });
		}
	};
}

/** Registers a visible placeholder test that runs only when TEST_DATABASE_URL is unset, so a skipped
 *  integration suite shows up in the output instead of vanishing (same pattern as queue.test.ts). */
export function placeholderWithoutDb(suite: string) {
	describe.skipIf(hasTestDb)(suite, () => {
		it(`is skipped: set TEST_DATABASE_URL to run ${suite}`, () => {
			expect(hasTestDb).toBe(false);
		});
	});
}
