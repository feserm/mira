import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { etlJob, roCrateStaging } from '$lib/server/db/schema';
import {
	claim,
	complete,
	enqueue,
	fail,
	getLatestJob,
	heartbeat,
	lockArc,
	reapExpired,
	release,
	setStep,
	type JobClaim
} from './queue';
import { createTestDb, hasTestDb, type TestDb } from './test-db';

const asClaim = (
	job: { id: string; arcId: number; attempts: number },
	workerId: string
): JobClaim => ({
	id: job.id,
	arcId: job.arcId,
	attempts: job.attempts,
	workerId
});

// These need a real Postgres: set TEST_DATABASE_URL (see test-db.ts). Skipped without it.
describe.skipIf(!hasTestDb)('etl queue (real Postgres)', () => {
	let t: TestDb;
	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.drop();
	});
	beforeEach(async () => {
		await t.db.delete(etlJob);
		await t.db.delete(roCrateStaging);
	});

	const enq = (arcId: number, kind: 'full' | 'transform' | 'load' = 'full') =>
		enqueue(t.db, { arcId, kind, requestedBy: t.userId });

	describe('enqueue', () => {
		it('deduplicates concurrent requests for one ARC to a single job', async () => {
			const results = await Promise.all(Array.from({ length: 8 }, () => enq(1)));
			expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
			expect(results.filter((r) => r.created)).toHaveLength(1);
			expect(await t.db.select().from(etlJob)).toHaveLength(1);
		});

		it('keeps one job per ARC while one is running, and allows a new one after it finished', async () => {
			const { job } = await enq(1);
			const running = (await claim(t.db, 'w1', 60))!;
			const again = await enq(1);
			expect(again.created).toBe(false);
			expect(again.job.id).toBe(job.id);

			await complete(t.db, asClaim(running, 'w1'));
			const next = await enq(1);
			expect(next.created).toBe(true);
			expect(next.job.id).not.toBe(job.id);
			expect((await getLatestJob(t.db, 1))?.id).toBe(next.job.id);
		});
	});

	describe('claim', () => {
		it('gives one job to exactly one of many concurrent claimers', async () => {
			await enq(1);
			const got = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(t.db, `w${i}`, 60)));
			expect(got.filter(Boolean)).toHaveLength(1);
			expect(got.find(Boolean)!.state).toBe('running');
			expect(got.find(Boolean)!.attempts).toBe(1);
		});

		it('runs different ARCs in parallel: two claimers get two different jobs', async () => {
			await enq(1);
			await enq(2);
			const [a, b] = await Promise.all([claim(t.db, 'w1', 60), claim(t.db, 'w2', 60)]);
			expect(a && b).toBeTruthy();
			expect(new Set([a!.arcId, b!.arcId])).toEqual(new Set([1, 2]));
		});

		it('serializes the same ARC: a duplicate request never becomes a second runnable job', async () => {
			await enq(7);
			await enq(7);
			const got = await Promise.all([claim(t.db, 'w1', 60), claim(t.db, 'w2', 60)]);
			expect(got.filter(Boolean)).toHaveLength(1);
		});

		it('does not claim a job before run_after', async () => {
			const { job } = await enq(1);
			await t.db
				.update(etlJob)
				.set({ runAfter: sql`now() + interval '1 hour'` })
				.where(eq(etlJob.id, job.id));
			expect(await claim(t.db, 'w1', 60)).toBeUndefined();
		});
	});

	describe('lease expiry and reclaim', () => {
		const expireLease = (id: string) =>
			t.db
				.update(etlJob)
				.set({ leaseExpiresAt: sql`now() - interval '1 second'` })
				.where(eq(etlJob.id, id));

		it('keeps a job with a live lease away from other workers, and lets a heartbeat extend it', async () => {
			await enq(1);
			const job = (await claim(t.db, 'w1', 60))!;
			expect(await claim(t.db, 'w2', 60)).toBeUndefined();
			expect(await heartbeat(t.db, asClaim(job, 'w1'), 60)).toBe(true);
		});

		it('reclaims a running job whose lease expired, and fences the old worker out', async () => {
			await enq(1);
			const first = (await claim(t.db, 'w1', 60))!;
			await expireLease(first.id);

			const second = (await claim(t.db, 'w2', 60))!;
			expect(second.id).toBe(first.id);
			expect(second.attempts).toBe(2);
			expect(second.lockedBy).toBe('w2');

			// The zombie's late writes match nothing and tell it to stop.
			expect(await heartbeat(t.db, asClaim(first, 'w1'), 60)).toBe(false);
			expect(await setStep(t.db, asClaim(first, 'w1'), 'load')).toBe(false);
			expect(await complete(t.db, asClaim(first, 'w1'))).toBe(false);
			expect(
				await fail(t.db, asClaim(first, 'w1'), 'x', { transient: false, retryDelaySeconds: 1 })
			).toBe('lost');
			expect((await getLatestJob(t.db, 1))?.state).toBe('running');

			expect(await complete(t.db, asClaim(second, 'w2'))).toBe(true);
			expect((await getLatestJob(t.db, 1))?.state).toBe('succeeded');
		});

		it('fails a dead job that used all its attempts, and marks the in-flight staging step failed', async () => {
			await t.db.insert(roCrateStaging).values({ arcId: 5, path: 'p5', extractStatus: 'success' });
			await enqueue(t.db, { arcId: 5, kind: 'full', requestedBy: t.userId, maxAttempts: 1 });
			const job = (await claim(t.db, 'w1', 60))!;
			await setStep(t.db, asClaim(job, 'w1'), 'load');
			await expireLease(job.id);

			// Not reclaimable any more ...
			expect(await claim(t.db, 'w2', 60)).toBeUndefined();
			// ... so the reaper fails it truthfully.
			const reaped = await reapExpired(t.db);
			expect(reaped.map((j) => j.id)).toEqual([job.id]);
			const latest = (await getLatestJob(t.db, 5))!;
			expect(latest.state).toBe('failed');
			expect(latest.error).toMatch(/stopped responding/);
			const [staging] = await t.db.select().from(roCrateStaging).where(eq(roCrateStaging.arcId, 5));
			expect(staging.loadStatus).toBe('failed');
			expect(staging.loadError).toMatch(/stopped responding/);
			expect(staging.extractStatus).toBe('success');
		});

		it('does not reap a job that still has attempts left', async () => {
			await enq(1);
			const job = (await claim(t.db, 'w1', 60))!;
			await expireLease(job.id);
			expect(await reapExpired(t.db)).toHaveLength(0);
			expect(await claim(t.db, 'w2', 60)).toBeDefined();
		});
	});

	describe('retry policy', () => {
		const opts = (transient: boolean) => ({ transient, retryDelaySeconds: 30 });

		it('re-queues a transient failure with a delay while attempts are left', async () => {
			await enq(1);
			const job = (await claim(t.db, 'w1', 60))!;
			expect(await fail(t.db, asClaim(job, 'w1'), 'timeout', opts(true))).toBe('retry');
			const after = (await getLatestJob(t.db, 1))!;
			expect(after.state).toBe('queued');
			expect(after.error).toBe('timeout');
			expect(after.lockedBy).toBeNull();
			expect(await claim(t.db, 'w2', 60)).toBeUndefined(); // still backing off
		});

		it('fails a transient failure once attempts are used up', async () => {
			await enqueue(t.db, { arcId: 1, kind: 'full', requestedBy: t.userId, maxAttempts: 1 });
			const job = (await claim(t.db, 'w1', 60))!;
			expect(await fail(t.db, asClaim(job, 'w1'), 'timeout', opts(true))).toBe('failed');
			expect((await getLatestJob(t.db, 1))?.state).toBe('failed');
		});

		it('fails a deterministic error immediately, without retry', async () => {
			await enq(1);
			const job = (await claim(t.db, 'w1', 60))!;
			expect(await fail(t.db, asClaim(job, 'w1'), 'bad RO-Crate', opts(false))).toBe('failed');
			const after = (await getLatestJob(t.db, 1))!;
			expect(after.state).toBe('failed');
			expect(after.attempts).toBe(1);
			expect(after.finishedAt).not.toBeNull();
		});

		it('release gives the job back without counting the attempt', async () => {
			await enq(1);
			const job = (await claim(t.db, 'w1', 60))!;
			expect(await release(t.db, asClaim(job, 'w1'), 'worker shutting down')).toBe(true);
			const again = (await claim(t.db, 'w2', 60))!;
			expect(again.attempts).toBe(1);
		});
	});

	describe('lockArc', () => {
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		async function overlapping(arcA: number, arcB: number): Promise<boolean> {
			let inside = 0;
			let overlapped = false;
			const work = (arcId: number) =>
				t.db.transaction(async (tx) => {
					await lockArc(tx, arcId);
					inside++;
					if (inside > 1) overlapped = true;
					await sleep(150);
					inside--;
				});
			await Promise.all([work(arcA), work(arcB)]);
			return overlapped;
		}

		it('serializes transactions for the same ARC', async () => {
			expect(await overlapping(1, 1)).toBe(false);
		});

		it('lets transactions for different ARCs run at the same time', async () => {
			expect(await overlapping(1, 2)).toBe(true);
		});
	});
});

describe.skipIf(hasTestDb)('etl queue (real Postgres)', () => {
	it('is skipped: set TEST_DATABASE_URL to run the queue tests against a throwaway database', () => {
		expect(hasTestDb).toBe(false);
	});
});
