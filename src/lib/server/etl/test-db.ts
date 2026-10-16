/** Throwaway Postgres database for tests that need the real thing (queue claiming, locks).
 *  Set TEST_DATABASE_URL to any URL on a Postgres server; the helper creates a uniquely named database
 *  there, applies the real migrations from ./drizzle, and drops it afterwards. It never touches the
 *  database named in the URL. Without TEST_DATABASE_URL the suites are skipped (see `hasTestDb`). */
import { randomUUID } from 'node:crypto';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { user } from '$lib/server/db/schema';

export const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
export const hasTestDb = !!testDbUrl;

export interface TestDb {
	url: string;
	db: PostgresJsDatabase<Record<string, unknown>>;
	client: postgres.Sql;
	userId: string;
	drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
	if (!testDbUrl) throw new Error('TEST_DATABASE_URL is not set');
	const name = `mira_test_${randomUUID().replace(/-/g, '')}`;
	const admin = postgres(testDbUrl, { max: 1, onnotice: () => {} });
	await admin.unsafe(`create database ${name}`);

	const url = new URL(testDbUrl);
	url.pathname = `/${name}`;
	const client = postgres(url.toString(), { max: 20, onnotice: () => {} });
	const db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });

	const userId = `u-${randomUUID()}`;
	await db.insert(user).values({ id: userId, name: 'Test', email: `${userId}@example.org` });

	return {
		url: url.toString(),
		db,
		client,
		userId,
		async drop() {
			await client.end({ timeout: 5 });
			await admin.unsafe(`drop database if exists ${name} with (force)`);
			await admin.end({ timeout: 5 });
		}
	};
}
