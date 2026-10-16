import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from './dml-db';
import { etlJob, roCrateStaging } from '$lib/server/db/schema';

// The integration suites run as the DML-only app role against a database migrated by the real
// migrator (docs/testing.md section 3). This suite proves that setup does what it claims.
describe.skipIf(!hasTestDb)('test database: DML-only app role', () => {
	let t: DmlTestDb;
	beforeAll(async () => {
		t = await createDmlTestDb();
	});
	afterAll(async () => {
		await t?.drop();
	});

	it('connects as the app role, not as the owner or a superuser', async () => {
		const [row] =
			await t.client`select current_user as u, usesuper from pg_user where usename = current_user`;
		expect(row.u).toBe(t.roles.app);
		expect(row.usesuper).toBe(false);
	});

	it('cannot run DDL: create, alter and drop are refused', async () => {
		await expect(t.client.unsafe('create table nope (i int)')).rejects.toThrow(/permission denied/);
		await expect(t.client.unsafe('alter table etl_job add column nope int')).rejects.toThrow(
			/must be owner/
		);
		await expect(t.client.unsafe('drop table etl_job')).rejects.toThrow(/must be owner/);
		await expect(t.client.unsafe('truncate etl_job')).rejects.toThrow(/permission denied/);
	});

	it('has the DML the pipeline needs: insert, update, delete, row locks and advisory locks', async () => {
		await t.db.insert(roCrateStaging).values({ arcId: 1, path: 'dml-check' });
		await t.db.update(roCrateStaging).set({ extractStatus: 'success' });
		await t.db.transaction(async (tx) => {
			await tx.execute(sql`select pg_advisory_xact_lock(1, 1)`);
			await tx.execute(sql`select id from ${etlJob} for update skip locked limit 1`);
		});
		await t.db.delete(roCrateStaging);
		const rows = await t.db.select().from(roCrateStaging);
		expect(rows).toHaveLength(0);
	});

	it('had the real migrations applied (bookkeeping exists, but is not readable by the app)', async () => {
		await expect(t.client.unsafe('select 1 from drizzle.__drizzle_migrations')).rejects.toThrow(
			/permission denied/
		);
	});
});
