/** The request_logs retention delete against real Postgres, connected as the DML-only role the CronJob
 *  uses (docs/testing.md section 3). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { requestLogs } from '$lib/server/db/schema';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import {
	DEFAULT_BATCH_SIZE,
	DEFAULT_RETENTION_DAYS,
	deleteExpiredRequestLogs,
	parseRetentionEnv
} from './retention';

const NOW = new Date('2026-10-26T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe('parseRetentionEnv', () => {
	it('defaults to 90 days and a batch of 5000', () => {
		expect(parseRetentionEnv({})).toEqual({
			config: { days: DEFAULT_RETENTION_DAYS, batchSize: DEFAULT_BATCH_SIZE },
			errors: []
		});
		expect(DEFAULT_RETENTION_DAYS).toBe(90);
	});

	it('reads both values and refuses anything else, naming the variable', () => {
		expect(
			parseRetentionEnv({ REQUEST_LOGS_RETENTION_DAYS: '30', REQUEST_LOGS_RETENTION_BATCH: '100' })
				.config
		).toEqual({ days: 30, batchSize: 100 });
		for (const bad of ['0', '-5', '1.5', 'soon', '99999']) {
			const { errors } = parseRetentionEnv({ REQUEST_LOGS_RETENTION_DAYS: bad });
			expect(errors).toEqual(['REQUEST_LOGS_RETENTION_DAYS must be an integer from 1 to 36500']);
		}
		expect(parseRetentionEnv({ REQUEST_LOGS_RETENTION_BATCH: '0' }).errors).toHaveLength(1);
	});
});

describe.skipIf(!hasTestDb)('deleteExpiredRequestLogs (real Postgres, DML-only role)', () => {
	let t: DmlTestDb;

	beforeAll(async () => {
		t = await createDmlTestDb();
	});
	afterAll(async () => {
		await t?.drop();
	});
	beforeEach(async () => {
		await t.db.delete(requestLogs);
	});

	const insert = (n: number, createdAt: Date, endpoint = '/[repo]/brapi/v2/trials') =>
		t.db.insert(requestLogs).values(
			Array.from({ length: n }, () => ({
				endpoint,
				method: 'GET',
				responseTimeMs: 5,
				status: 200,
				createdAt
			}))
		);
	const count = async () =>
		Number((await t.db.execute(sql`select count(*)::int as n from request_logs`))[0].n);

	it('runs as the DML role, which cannot do DDL', async () => {
		const [{ me }] = await t.db.execute<{ me: string }>(sql`select current_user as me`);
		expect(me).toBe(t.roles.app);
		await expect(t.db.execute(sql`create table nope (i int)`)).rejects.toThrow();
	});

	it('deletes rows older than the period and keeps newer ones', async () => {
		await insert(3, daysAgo(120));
		await insert(2, daysAgo(91));
		await insert(4, daysAgo(89));
		await insert(1, NOW);

		const result = await deleteExpiredRequestLogs(t.db, {
			days: 90,
			batchSize: 1000,
			now: NOW,
			pauseMs: 0
		});
		expect(result.deleted).toBe(5);
		expect(result.cutoff).toEqual(daysAgo(90));
		expect(await count()).toBe(5);
		const oldest = await t.db.execute<{ age: number }>(
			sql`select extract(epoch from (${NOW.toISOString()}::timestamptz - min(created_at)))::float8 / 86400 as age from request_logs`
		);
		expect(Number(oldest[0].age)).toBeLessThan(90);
	});

	it('keeps a row exactly at the cutoff', async () => {
		await insert(1, daysAgo(90));
		await insert(1, new Date(daysAgo(90).getTime() - 1000));
		const result = await deleteExpiredRequestLogs(t.db, {
			days: 90,
			batchSize: 10,
			now: NOW,
			pauseMs: 0
		});
		expect(result.deleted).toBe(1);
		expect(await count()).toBe(1);
	});

	it('works in batches no larger than the batch size, so no statement holds a long lock', async () => {
		await insert(25, daysAgo(200));
		await insert(3, NOW);
		const result = await deleteExpiredRequestLogs(t.db, {
			days: 90,
			batchSize: 10,
			now: NOW,
			pauseMs: 0
		});
		expect(result).toMatchObject({ deleted: 25, batches: 3 });
		expect(await count()).toBe(3);

		await insert(20, daysAgo(200));
		const exact = await deleteExpiredRequestLogs(t.db, {
			days: 90,
			batchSize: 10,
			now: NOW,
			pauseMs: 0
		});
		expect(exact).toMatchObject({ deleted: 20, batches: 2 });
	});

	it('is idempotent: a second run deletes nothing and a run on an empty table is fine', async () => {
		await insert(7, daysAgo(100));
		await insert(2, daysAgo(1));
		const opts = { days: 90, batchSize: 5, now: NOW, pauseMs: 0 };
		expect((await deleteExpiredRequestLogs(t.db, opts)).deleted).toBe(7);
		expect(await deleteExpiredRequestLogs(t.db, opts)).toMatchObject({ deleted: 0, batches: 0 });
		await t.db.delete(requestLogs);
		expect((await deleteExpiredRequestLogs(t.db, opts)).deleted).toBe(0);
	});

	it('removes old rows whatever they hold, raw paths from before S2.9 included', async () => {
		await insert(2, daysAgo(100), '/Group%2FAlpha/brapi/v2/trials');
		await insert(1, daysAgo(10), '/Group%2FAlpha/brapi/v2/trials');
		await deleteExpiredRequestLogs(t.db, { days: 90, batchSize: 10, now: NOW, pauseMs: 0 });
		expect(await count()).toBe(1);
	});

	it('can find the oldest rows through the created_at index (no table scan needed)', async () => {
		await insert(50, daysAgo(200));
		await t.client.unsafe('analyze request_logs');
		// planner choice on a tiny table is not the point: with scans off, the plan must be an index scan
		const plan = await t.client.begin(async (tx) => {
			await tx.unsafe('set local enable_seqscan = off');
			return tx.unsafe(
				`explain select id from request_logs where created_at < now() - interval '90 days' order by created_at limit 10`
			);
		});
		const text = plan.map((r) => String(Object.values(r)[0])).join('\n');
		expect(text).toContain('request_logs_created_at_idx');
	});
});
