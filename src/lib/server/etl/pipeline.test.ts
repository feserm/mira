import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { roCrateStaging, type EtlJob } from '$lib/server/db/schema';
import { arcSpec, roCrate } from '$lib/server/test-support/arc-fixtures';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import { resetData, tableCounts } from '$lib/server/test-support/seed';
import { waitFor } from '$lib/server/test-support/wait';
import { executeJob } from './execute';
import { enqueue, getLatestJob, type JobKind } from './queue';
import { startRunner, type Runner } from './runner';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
// plantdatahub.ts reads the issuer and timeouts from validated env at import time.
vi.mock('$lib/server/env', () => ({
	config: {
		oidc: { issuerUrl: 'https://gitlab.test' },
		http: { headersTimeoutSeconds: 5, totalTimeoutSeconds: 10 }
	}
}));

const ARC_ID = 42;
const PATH = 'Sample-Group/Sample-ARC';
const TOKEN = 'test-token';

/** What the stubbed PLANTdataHUB answers. Replaced per test. */
interface GitlabStub {
	/** responses for successive downloads of the RO-Crate; the last one repeats */
	crate: (() => Response)[];
	project: () => Response;
}
let gitlab: GitlabStub;
const seen: { url: string; authorization: string | null }[] = [];

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fetchStub(input: string | URL | Request, init?: RequestInit) {
	const url = String(input);
	seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
	if (url.startsWith('https://gitlab.test/api/v4/projects/42/packages/')) {
		const next = gitlab.crate.length > 1 ? gitlab.crate.shift()! : gitlab.crate[0];
		return Promise.resolve(next());
	}
	if (url.startsWith('https://gitlab.test/api/v4/projects/42?'))
		return Promise.resolve(gitlab.project());
	// NCBI crop name lookup: unavailable
	return Promise.resolve(new Response('unavailable', { status: 500 }));
}

// Real Postgres (DML-only role), the real worker steps and runner, a stubbed PLANTdataHUB.
describe.skipIf(!hasTestDb)('ETL pipeline end to end (stubbed PLANTdataHUB)', () => {
	let t: DmlTestDb;
	const runners: Runner[] = [];

	beforeAll(async () => {
		vi.stubGlobal('fetch', vi.fn(fetchStub));
		t = await createDmlTestDb();
		useTestDb(t.db);
	});
	afterAll(async () => {
		vi.unstubAllGlobals();
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(async () => {
		await resetData(t.db);
		seen.length = 0;
		gitlab = {
			crate: [() => json(roCrate(arcSpec()))],
			project: () => json({ id: ARC_ID, path: PATH })
		};
	});
	afterEach(async () => {
		await Promise.all(runners.splice(0).map((r) => r.stop()));
	});

	/** Enqueues a job, runs the real executeJob under the real runner, resolves with the finished job. */
	async function runJob(kind: JobKind, maxAttempts = 3): Promise<EtlJob> {
		await enqueue(t.db, { arcId: ARC_ID, kind, requestedBy: t.userId, maxAttempts });
		runners.push(
			startRunner({
				db: t.db,
				workerId: 'test-worker',
				concurrency: 1,
				leaseSeconds: 30,
				pollSeconds: 0.05,
				retryDelaySeconds: 0,
				shutdownTimeoutSeconds: 5,
				log: () => {},
				execute: (job, beginStep) =>
					executeJob(job.kind, job.arcId, {
						userId: job.requestedBy,
						getToken: async () => TOKEN,
						beginStep
					})
			})
		);
		await waitFor(async () => {
			const job = await getLatestJob(t.db, ARC_ID);
			return job?.state === 'succeeded' || job?.state === 'failed';
		}, 'the job to finish');
		await Promise.all(runners.splice(0).map((r) => r.stop()));
		return (await getLatestJob(t.db, ARC_ID))!;
	}

	/** Row counts of the imported data: every table except the job history, which grows per job. */
	const entityCounts = async () => {
		const counts = await tableCounts(t.db);
		delete counts.etl_job;
		return counts;
	};

	const staging = async () =>
		(await t.db.select().from(roCrateStaging).where(eq(roCrateStaging.arcId, ARC_ID)))[0];

	it('runs Extract, Transform and Load and leaves ro_crate_staging truthful', async () => {
		const job = await runJob('full');

		expect(job).toMatchObject({ state: 'succeeded', error: null, attempts: 1 });
		const row = await staging();
		expect(row).toMatchObject({
			arcId: ARC_ID,
			path: PATH,
			extractStatus: 'success',
			transformStatus: 'success',
			loadStatus: 'success',
			extractError: null,
			transformError: null,
			loadError: null,
			extractedBy: t.userId,
			transformedBy: t.userId,
			loadedBy: t.userId
		});
		expect(row.extractedAt).toBeInstanceOf(Date);
		expect(row.transformedAt).toBeInstanceOf(Date);
		expect(row.loadedAt).toBeInstanceOf(Date);
		expect((row.rawRoCrate as { '@graph': unknown[] })['@graph'].length).toBeGreaterThan(0);

		expect(await tableCounts(t.db)).toMatchObject({
			trial: 1,
			study: 2,
			contact: 4,
			germplasm: 2,
			observation_unit: 2
		});
	});

	it("calls PLANTdataHUB with the importing user's token, for the project and the RO-Crate", async () => {
		await runJob('full');
		const gitlabCalls = seen.filter((c) => c.url.startsWith('https://gitlab.test'));
		expect(gitlabCalls).toHaveLength(2);
		expect(gitlabCalls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
	});

	it('importing the same ARC twice through the pipeline leaves the row counts unchanged', async () => {
		await runJob('full');
		const counts = await entityCounts();
		const second = await runJob('full');
		expect(second.state).toBe('succeeded');
		expect(await entityCounts()).toEqual(counts);
	});

	it('a failed Extract (404) fails the job at once, with a readable error and no staging row', async () => {
		gitlab.crate = [() => new Response('missing', { status: 404 })];
		const job = await runJob('full');
		expect(job).toMatchObject({ state: 'failed', attempts: 1 });
		expect(job.error).toMatch(/Could not fetch RO-Crate metadata/);
		expect(await staging()).toBeUndefined();
		expect((await entityCounts()).trial).toBe(0);
	});

	it('retries a transient PLANTdataHUB failure (503) and then succeeds', async () => {
		gitlab.crate = [() => new Response('busy', { status: 503 }), () => json(roCrate(arcSpec()))];
		const job = await runJob('full');
		expect(job).toMatchObject({ state: 'succeeded', attempts: 2 });
		expect((await staging()).loadStatus).toBe('success');
	});

	it('gives up after the attempts are used up on a persistent 503, with the staging row absent', async () => {
		gitlab.crate = [() => new Response('busy', { status: 503 })];
		const job = await runJob('full', 2);
		expect(job).toMatchObject({ state: 'failed', attempts: 2 });
		expect(await staging()).toBeUndefined();
	});

	it('records a Transform failure on the staging row and leaves the earlier import intact', async () => {
		await runJob('full');
		const counts = await entityCounts();
		gitlab.crate = [() => json({ '@context': 'https://example.org', '@graph': [] })];

		const job = await runJob('full');

		expect(job.state).toBe('failed');
		expect(job.error).toMatch(/Could not parse ARC-RO-Crate metadata/);
		const row = await staging();
		expect(row).toMatchObject({
			extractStatus: 'success',
			transformStatus: 'failed',
			loadStatus: 'pending'
		});
		expect(row.transformError).toMatch(/Could not parse ARC-RO-Crate metadata/);
		expect(row.loadedAt).toBeNull(); // reset by the new run: it does not claim the old Load
		expect(await entityCounts()).toEqual(counts);
	});

	it('refuses a transform job before Extract and a load job before Transform', async () => {
		const early = await runJob('transform');
		expect(early).toMatchObject({
			state: 'failed',
			error: 'Extract must succeed before transforming.'
		});

		await t.db
			.insert(roCrateStaging)
			.values({ arcId: ARC_ID, path: PATH, extractStatus: 'success' });
		const tooEarly = await runJob('load');
		expect(tooEarly).toMatchObject({
			state: 'failed',
			error: 'Transform must succeed before loading.'
		});
	});

	it('a transform job re-runs Transform and Load from the staged crate without calling PLANTdataHUB', async () => {
		await runJob('full');
		seen.length = 0;
		const counts = await entityCounts();

		const job = await runJob('transform');

		expect(job.state).toBe('succeeded');
		expect(seen.filter((c) => c.url.startsWith('https://gitlab.test'))).toHaveLength(0);
		expect(await entityCounts()).toEqual(counts);
		expect((await staging()).loadStatus).toBe('success');
	});
});

placeholderWithoutDb('ETL pipeline end to end (stubbed PLANTdataHUB)');
