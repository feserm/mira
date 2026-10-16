/** Contract tests every BrAPI endpoint must pass, whatever it returns: authentication, `[repo]`
 *  resolution, the response envelope, pagination, and isolation between ARCs. They call the real
 *  `+server.ts` handlers against a seeded Postgres (DML-only role). Endpoint-specific filters, sorting and
 *  field shapes are in endpoints.test.ts. How a caller is authenticated lives in
 *  `$lib/server/test-support/brapi-event.ts`. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { germplasm, location, observationUnit, study, trial } from '$lib/server/db/schema';
import { ARC_IDS, REPOS, seedBrapiFixture } from '$lib/server/test-support/brapi-fixture';
import {
	anonymousLocals,
	callBrapi,
	type BrapiHandler
} from '$lib/server/test-support/brapi-event';
import { useTestDb } from '$lib/server/test-support/db-mock';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import { GET as germplasmGET } from './germplasm/+server';
import { GET as mcpdGET } from './germplasm/[germplasmDbId]/mcpd/+server';
import { GET as locationsGET } from './locations/+server';
import { GET as observationUnitsGET } from './observationunits/+server';
import { GET as serverinfoGET } from './serverinfo/+server';
import { GET as studiesGET } from './studies/+server';
import { GET as trialsGET } from './trials/+server';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);

/** [service, handler, id field in the response, query parameter that selects one by id] */
const LIST_ENDPOINTS: [string, BrapiHandler, string, string][] = [
	['trials', trialsGET, 'trialDbId', 'trialDbId'],
	['studies', studiesGET, 'studyDbId', 'studyDbId'],
	['locations', locationsGET, 'locationDbId', 'locationDbId'],
	['observationunits', observationUnitsGET, 'observationUnitDbId', 'observationUnitDbId'],
	['germplasm', germplasmGET, 'germplasmDbId', 'germplasmDbId']
];

describe.skipIf(!hasTestDb)('BrAPI handlers: contract (real Postgres, DML-only role)', () => {
	let t: DmlTestDb;
	beforeAll(async () => {
		vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 500 }));
		t = await createDmlTestDb();
		useTestDb(t.db);
		await seedBrapiFixture(t); // read-only from here on: tests share it and cannot affect each other
	});
	afterAll(async () => {
		vi.unstubAllGlobals();
		useTestDb(undefined);
		await t?.drop();
	});

	describe.each([
		...LIST_ENDPOINTS.map(([name, handler]) => [name, handler] as const),
		['serverinfo', serverinfoGET as BrapiHandler] as const
	])('%s', (_name, handler) => {
		it('answers 401 without a signed-in user, and exposes no data', async () => {
			const res = await callBrapi(handler, { repo: REPOS.alpha, locals: anonymousLocals() });
			expect(res.status).toBe(401);
			expect(res.body).not.toHaveProperty('result');
		});

		it('answers 401 before it reveals whether the repo exists', async () => {
			const res = await callBrapi(handler, { repo: 'No/Such-Arc', locals: anonymousLocals() });
			expect(res.status).toBe(401);
		});

		it('answers 404 for an unknown [repo]', async () => {
			const res = await callBrapi(handler, { repo: 'No/Such-Arc' });
			expect(res.status).toBe(404);
			expect(res.body.message).toContain('No/Such-Arc');
		});

		it('resolves [repo] case-insensitively', async () => {
			const canonical = await callBrapi(handler, { repo: REPOS.alpha });
			expect(canonical.status).toBe(200);
			for (const repo of ['group/alpha', 'GROUP/ALPHA', 'gRoUp/aLpHa']) {
				expect(await callBrapi(handler, { repo })).toEqual(canonical);
			}
		});
	});

	describe.each(LIST_ENDPOINTS)('%s (list)', (_name, handler, idField, idParam) => {
		it('returns the BrAPI list envelope with pagination metadata', async () => {
			const { status, body } = await callBrapi(handler, { repo: REPOS.alpha });
			expect(status).toBe(200);
			expect(Object.keys(body).sort()).toEqual(['metadata', 'result']);
			expect(body.metadata.datafiles).toEqual([]);
			expect(body.metadata.status).toEqual([]);
			expect(Array.isArray(body.result.data)).toBe(true);
			const { pagination } = body.metadata;
			expect(pagination).toEqual({
				currentPage: 0,
				pageSize: 1000,
				totalCount: body.result.data.length,
				totalPages: 1
			});
			expect(body.result.data.length).toBeGreaterThan(0); // not vacuous: alpha has this entity
		});

		it('gives every item a non-empty string id', async () => {
			const { body } = await callBrapi(handler, { repo: REPOS.alpha });
			for (const item of body.result.data) {
				expect(typeof item[idField]).toBe('string');
				expect(item[idField].length).toBeGreaterThan(0);
			}
		});

		it('honours page and pageSize and reports the real totals', async () => {
			const all = (await callBrapi(handler, { repo: REPOS.alpha })).body.result.data;
			const first = await callBrapi(handler, {
				repo: REPOS.alpha,
				query: { pageSize: 1, page: 0 }
			});
			expect(first.body.result.data).toHaveLength(1);
			expect(first.body.metadata.pagination).toEqual({
				currentPage: 0,
				pageSize: 1,
				totalCount: all.length,
				totalPages: all.length
			});
			expect(first.body.result.data[0][idField]).toBe(all[0][idField]);

			const past = await callBrapi(handler, {
				repo: REPOS.alpha,
				query: { pageSize: 1, page: all.length }
			});
			expect(past.body.result.data).toEqual([]);
			expect(past.body.metadata.pagination.totalCount).toBe(all.length);

			if (all.length > 1) {
				const second = await callBrapi(handler, {
					repo: REPOS.alpha,
					query: { pageSize: 1, page: 1 }
				});
				expect(second.body.result.data[0][idField]).toBe(all[1][idField]);
			}
		});

		it.each([
			['page', '-1'],
			['page', '1.5'],
			['page', 'abc'],
			['pageSize', '0'],
			['pageSize', '-5'],
			['pageSize', 'many']
		])('answers 400 for %s=%s', async (param, value) => {
			const res = await callBrapi(handler, { repo: REPOS.alpha, query: { [param]: value } });
			expect(res.status).toBe(400);
		});

		it('shows an ARC only its own data: no id of another ARC appears, and none can be selected by id', async () => {
			const alpha = (await callBrapi(handler, { repo: REPOS.alpha })).body.result.data;
			const beta = (await callBrapi(handler, { repo: REPOS.beta })).body.result.data;
			const alphaIds = new Set(alpha.map((i: Record<string, string>) => i[idField]));
			const betaIds = beta.map((i: Record<string, string>) => i[idField]);
			expect(betaIds.length).toBeGreaterThan(0);
			for (const id of betaIds) expect(alphaIds.has(id)).toBe(false);
			expect(JSON.stringify(alpha)).not.toMatch(/Beta|INV-BETA|Seed-C|Site Y|Oryza/);

			// asking alpha for one of beta's ids must find nothing, not beta's row
			for (const id of betaIds) {
				const res = await callBrapi(handler, { repo: REPOS.alpha, query: { [idParam]: id } });
				expect(res.status).toBe(200);
				expect(res.body.result.data).toEqual([]);
				expect(res.body.metadata.pagination.totalCount).toBe(0);
			}
		});
	});

	describe('data shared between ARCs is shown to each ARC that references it', () => {
		it('a location used by two ARCs appears under both, and not under a third', async () => {
			const names = async (repo: string) =>
				(await callBrapi(locationsGET, { repo })).body.result.data.map(
					(l: { locationName: string }) => l.locationName
				);
			expect(await names(REPOS.alpha)).toEqual(['Site X']);
			expect(await names(REPOS.gamma)).toEqual(['Site X']);
			expect(await names(REPOS.beta)).toEqual(['Site Y']);
			// one row in the database: that is what "shared" means here
			expect(await t.db.select().from(location)).toHaveLength(2);
		});

		it('a contact shared by two ARCs appears in both trials', async () => {
			const roe = async (repo: string) => {
				const [theTrial] = (await callBrapi(trialsGET, { repo })).body.result.data;
				return theTrial.contacts.filter(
					(c: { orcid: string }) => c.orcid === '0000-0001-2345-6789'
				);
			};
			const [inAlpha, inBeta] = [await roe(REPOS.alpha), await roe(REPOS.beta)];
			expect(inAlpha).toHaveLength(1);
			expect(inBeta).toHaveLength(1);
			expect(inAlpha[0].contactDbId).toBe(inBeta[0].contactDbId);
		});
	});

	describe('germplasm/{id}/mcpd', () => {
		const call = (
			repo: string,
			germplasmDbId: string,
			locals?: ReturnType<typeof anonymousLocals>
		) => callBrapi(mcpdGET, { repo, params: { germplasmDbId }, locals });
		const idOf = async (arc: keyof typeof ARC_IDS, name: string) => {
			const ids = await t.db
				.select({ id: germplasm.id, name: germplasm.germplasmName })
				.from(germplasm)
				.innerJoin(observationUnit, eq(observationUnit.germplasmId, germplasm.id))
				.where(eq(observationUnit.arcId, ARC_IDS[arc]));
			return ids.find((g) => g.name === name)!.id;
		};

		it('answers 401 without a user and 404 for an unknown [repo]', async () => {
			const id = await idOf('alpha', 'Seed-A');
			expect((await call(REPOS.alpha, id, anonymousLocals())).status).toBe(401);
			expect((await call('No/Such-Arc', id)).status).toBe(404);
		});

		it('returns the MCPD record in the single-result envelope', async () => {
			const id = await idOf('alpha', 'Seed-A');
			const { status, body } = await call(REPOS.alpha, id);
			expect(status).toBe(200);
			expect(Object.keys(body).sort()).toEqual(['metadata', 'result']);
			expect(body.metadata).toEqual({ datafiles: [], status: [] });
			expect(body.result).toMatchObject({
				germplasmDbId: id,
				genus: 'Zea',
				species: 'mays',
				germplasmPUI: '1:Seed-A'
			});
		});

		it('answers 404 for a germplasm that belongs to another ARC, and for an unknown id', async () => {
			const betaOnly = await idOf('beta', 'Seed-C');
			expect((await call(REPOS.alpha, betaOnly)).status).toBe(404);
			expect((await call(REPOS.alpha, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
		});
	});

	// Sanity for the isolation tests above: the three ARCs really are separate in the database.
	it('the fixture has separate rows per ARC', async () => {
		const trials = await t.db.select({ arcId: trial.arcId }).from(trial);
		expect(trials.map((r) => r.arcId).sort()).toEqual([1, 2, 3]);
		expect(await t.db.select().from(study).where(eq(study.arcId, ARC_IDS.beta))).toHaveLength(2);
	});
});
