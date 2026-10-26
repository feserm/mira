import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { etlJob } from '$lib/server/db/schema';
import { FetchTimeoutError } from '$lib/server/fetch-timeout';
import { setLogSink } from '$lib/server/log';
import { enqueue, getLatestJob } from './queue';
import { startRunner, type JobOutcome, type Runner, type RunnerOptions } from './runner';
import { createTestDb, hasTestDb, type TestDb } from './test-db';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean>, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await sleep(25);
	}
	throw new Error('condition not reached in time');
}

// Real Postgres, fake pipeline. Set TEST_DATABASE_URL to run (see test-db.ts).
describe.skipIf(!hasTestDb)('etl runner (real Postgres)', () => {
	let t: TestDb;
	const runners: Runner[] = [];

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.drop();
	});
	beforeEach(async () => {
		await t.db.delete(etlJob);
	});
	afterEach(async () => {
		await Promise.all(runners.splice(0).map((r) => r.stop()));
	});

	function run(
		workerId: string,
		execute: RunnerOptions['execute'],
		extra: Partial<RunnerOptions> = {}
	) {
		const runner = startRunner({
			db: t.db,
			workerId,
			concurrency: 1,
			leaseSeconds: 30,
			pollSeconds: 0.05,
			retryDelaySeconds: 0,
			shutdownTimeoutSeconds: 5,
			log: () => {},
			execute,
			...extra
		});
		runners.push(runner);
		return runner;
	}

	const enq = (arcId: number, maxAttempts = 3) =>
		enqueue(t.db, { arcId, kind: 'full', requestedBy: t.userId, maxAttempts });
	const stateOf = async (arcId: number) => (await getLatestJob(t.db, arcId))!;
	const ok = async (): Promise<JobOutcome> => ({ ok: true });

	it('runs a job to success and records its steps', async () => {
		const steps: string[] = [];
		await enq(1);
		run('w1', async (_job, beginStep) => {
			for (const s of ['extract', 'transform', 'load'] as const) {
				await beginStep(s);
				steps.push(s);
			}
			return { ok: true };
		});
		await until(async () => (await stateOf(1)).state === 'succeeded');
		const job = await stateOf(1);
		expect(steps).toEqual(['extract', 'transform', 'load']);
		expect(job.attempts).toBe(1);
		expect(job.error).toBeNull();
		expect(job.finishedAt).not.toBeNull();
		expect(job.lockedBy).toBeNull();
	});

	it('writes structured JSON lines: one per step and one per outcome, with the job and the timings', async () => {
		const lines: string[] = [];
		setLogSink((l) => lines.push(l));
		try {
			await enq(7);
			run(
				'w-log',
				async (_job, beginStep) => {
					for (const s of ['extract', 'transform'] as const) {
						await beginStep(s);
						await sleep(15);
					}
					return { ok: true };
				},
				{ log: undefined }
			);
			await until(async () => (await stateOf(7)).state === 'succeeded');
			await until(async () => lines.some((l) => l.includes('succeeded')));
		} finally {
			setLogSink(undefined);
		}

		const entries = lines.map((l) => JSON.parse(l));
		const job = await stateOf(7);
		for (const e of entries) {
			expect(e).toMatchObject({ jobId: job.id, arcId: 7, kind: 'full', workerId: 'w-log' });
			expect(new Date(e.ts).getTime()).not.toBeNaN();
		}
		const steps = entries.filter((e) => e.event === 'etl.step');
		expect(steps.map((e) => e.step)).toEqual(['extract', 'transform']);
		expect(steps[1]).toMatchObject({ previousStep: 'extract' });
		expect(steps[1].previousStepMs).toBeGreaterThanOrEqual(10);
		const ended = entries.find((e) => e.event === 'etl.job' && e.outcome === 'succeeded');
		expect(ended).toMatchObject({ level: 'info', lastStep: 'transform' });
		expect(ended.durationMs).toBeGreaterThanOrEqual(25);
		expect(ended.msg).toMatch(/^etl: job=.* succeeded in \d+\.\ds$/);
	});

	it('logs a failed job at error level with the readable error, and a retry at warn', async () => {
		const lines: string[] = [];
		setLogSink((l) => lines.push(l));
		try {
			await enq(8, 1);
			run('w-fail', async () => ({ ok: false, error: 'Extract failed: 404', transient: false }), {
				log: undefined
			});
			await until(async () => (await stateOf(8)).state === 'failed');
			await until(async () => lines.some((l) => l.includes('Extract failed')));
		} finally {
			setLogSink(undefined);
		}
		const failed = lines.map((l) => JSON.parse(l)).find((e) => e.outcome === 'failed');
		expect(failed).toMatchObject({ level: 'error', event: 'etl.job', transient: false });
		expect(failed.msg).toContain('Extract failed: 404');
	});

	it('retries a transient failure and then succeeds', async () => {
		await enq(1);
		let calls = 0;
		run('w1', async () => {
			calls++;
			return calls === 1
				? { ok: false, error: new FetchTimeoutError('headers', 1000, 'h').message, transient: true }
				: { ok: true };
		});
		await until(async () => (await stateOf(1)).state === 'succeeded');
		expect(calls).toBe(2);
		expect((await stateOf(1)).attempts).toBe(2);
	});

	it('does not retry a deterministic failure, and keeps the readable error', async () => {
		await enq(1);
		let calls = 0;
		run('w1', async () => {
			calls++;
			return { ok: false, error: 'RO-Crate is not valid JSON-LD', transient: false };
		});
		await until(async () => (await stateOf(1)).state === 'failed');
		await sleep(200);
		expect(calls).toBe(1);
		expect((await stateOf(1)).error).toBe('RO-Crate is not valid JSON-LD');
	});

	it('gives up after max attempts of transient failures', async () => {
		await enq(1, 2);
		let calls = 0;
		run('w1', async () => {
			calls++;
			return { ok: false, error: 'PLANTdataHUB API request failed (503)', transient: true };
		});
		await until(async () => (await stateOf(1)).state === 'failed');
		expect(calls).toBe(2);
	});

	it('turns an unexpected exception into a failed job instead of a stuck one', async () => {
		await enq(1);
		run('w1', async () => {
			throw new Error('boom');
		});
		await until(async () => (await stateOf(1)).state === 'failed');
		expect((await stateOf(1)).error).toBe('boom');
	});

	it('runs different ARCs in parallel on one worker (concurrency 2)', async () => {
		await enq(1);
		await enq(2);
		let running = 0;
		let peak = 0;
		run(
			'w1',
			async () => {
				peak = Math.max(peak, ++running);
				await sleep(300);
				running--;
				return { ok: true };
			},
			{ concurrency: 2 }
		);
		await until(async () => (await stateOf(1)).state === 'succeeded');
		await until(async () => (await stateOf(2)).state === 'succeeded');
		expect(peak).toBe(2);
	});

	it('never runs one ARC twice at the same time, across two workers', async () => {
		await Promise.all([enq(1), enq(1), enq(1)]);
		let running = 0;
		let peak = 0;
		let calls = 0;
		const slow: RunnerOptions['execute'] = async () => {
			calls++;
			peak = Math.max(peak, ++running);
			await sleep(300);
			running--;
			return { ok: true };
		};
		run('w1', slow);
		run('w2', slow);
		await until(async () => (await stateOf(1)).state === 'succeeded');
		await sleep(300);
		expect(peak).toBe(1);
		expect(calls).toBe(1); // the duplicate requests were deduplicated, not queued behind
	});

	it('keeps a long job alive with heartbeats so no one steals it', async () => {
		await enq(1);
		let calls = 0;
		const slow: RunnerOptions['execute'] = async () => {
			calls++;
			await sleep(2500); // much longer than the 1s lease
			return { ok: true };
		};
		run('w1', slow, { leaseSeconds: 1 });
		run('w2', slow, { leaseSeconds: 1 });
		await until(async () => (await stateOf(1)).state === 'succeeded', 8000);
		expect(calls).toBe(1);
		expect((await stateOf(1)).attempts).toBe(1);
	});

	it('reclaims the job of a worker that died, and fences the zombie out', async () => {
		await enq(1);
		let release!: () => void;
		const zombieGate = new Promise<void>((r) => (release = r));
		// w1 "hangs" (stands in for a killed pod); it cannot heartbeat because we expire its lease below.
		const zombie = run(
			'w1',
			async (_job, beginStep) => {
				await beginStep('extract');
				await zombieGate;
				return { ok: true };
			},
			{ leaseSeconds: 3600 } // heartbeats effectively never fire
		);
		await until(async () => (await stateOf(1)).lockedBy === 'w1');
		await t.db
			.update(etlJob)
			.set({ leaseExpiresAt: sql`now() - interval '1 second'` })
			.where(eq(etlJob.arcId, 1));

		const calls: string[] = [];
		run('w2', async (_job, beginStep) => {
			calls.push('w2');
			await beginStep('extract');
			return { ok: true };
		});
		await until(async () => (await stateOf(1)).state === 'succeeded');
		expect(calls).toEqual(['w2']);
		expect((await stateOf(1)).attempts).toBe(2);

		// The zombie wakes up and tries to finish: nothing changes.
		release();
		await sleep(200);
		const job = await stateOf(1);
		expect(job.state).toBe('succeeded');
		expect(job.attempts).toBe(2);
		void zombie;
	});

	it('on shutdown waits for a short job to finish', async () => {
		await enq(1);
		const runner = run('w1', async () => {
			await sleep(300);
			return { ok: true };
		});
		await until(async () => (await stateOf(1)).state === 'running');
		await runner.stop();
		expect((await stateOf(1)).state).toBe('succeeded');
	});

	it('on shutdown hands a job that will not finish in time back to the queue', async () => {
		await enq(1);
		const runner = run(
			'w1',
			async () => {
				await sleep(3000);
				return { ok: true };
			},
			{ shutdownTimeoutSeconds: 0.3 }
		);
		await until(async () => (await stateOf(1)).state === 'running');
		await runner.stop();
		const job = await stateOf(1);
		expect(job.state).toBe('queued');
		expect(job.attempts).toBe(0);
		expect(job.error).toMatch(/shut down/);
		// ... and another worker picks it up.
		run('w2', ok);
		await until(async () => (await stateOf(1)).state === 'succeeded');
	});

	it('stops with a fatal callback when the database stays unreachable', async () => {
		const reasons: string[] = [];
		const broken = { ...t.db, transaction: () => Promise.reject(new Error('db down')) };
		run('w1', ok, {
			db: broken as unknown as RunnerOptions['db'],
			maxConsecutivePollFailures: 3,
			pollSeconds: 0.01,
			onFatal: (r) => reasons.push(r)
		});
		await until(async () => reasons.length > 0);
		expect(reasons[0]).toMatch(/3 consecutive failed polls/);
	});
});

describe.skipIf(hasTestDb)('etl runner (real Postgres)', () => {
	it('is skipped: set TEST_DATABASE_URL to run the runner tests against a throwaway database', () => {
		expect(hasTestDb).toBe(false);
	});
});
