/** Endpoint-specific behaviour: fields, filters, sorting and the BrAPI shapes. Cross-cutting rules
 *  (auth, [repo], envelope, pagination, ARC isolation) are in contract.test.ts. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { contact, germplasm, location, study } from '$lib/server/db/schema';
import { REPOS, seedBrapiFixture } from '$lib/server/test-support/brapi-fixture';
import { callBrapi, type BrapiHandler } from '$lib/server/test-support/brapi-event';
import { useTestDb } from '$lib/server/test-support/db-mock';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import { GET as germplasmGET } from './germplasm/+server';
import { GET as locationsGET } from './locations/+server';
import { GET as observationUnitsGET } from './observationunits/+server';
import { GET as serverinfoGET } from './serverinfo/+server';
import { GET as studiesGET } from './studies/+server';
import { GET as trialsGET } from './trials/+server';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);

const ROE_ORCID = '0000-0001-2345-6789';

describe.skipIf(!hasTestDb)('BrAPI handlers: endpoints (real Postgres, DML-only role)', () => {
	let t: DmlTestDb;
	beforeAll(async () => {
		vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 500 }));
		t = await createDmlTestDb();
		useTestDb(t.db);
		await seedBrapiFixture(t);
	});
	afterAll(async () => {
		vi.unstubAllGlobals();
		useTestDb(undefined);
		await t?.drop();
	});

	const get = (
		handler: BrapiHandler,
		query: Record<string, string | number | boolean> = {},
		repo: string = REPOS.alpha
	) => callBrapi(handler, { repo, query });
	const data = async (handler: BrapiHandler, query = {}, repo: string = REPOS.alpha) =>
		(await get(handler, query, repo)).body.result.data;

	describe('GET /trials', () => {
		it("returns the ARC's trial with the BrAPI trial fields", async () => {
			const [theTrial, ...rest] = await data(trialsGET);
			expect(rest).toHaveLength(0);
			expect(theTrial).toMatchObject({
				trialName: 'Drought trial',
				trialDescription: 'Barley and maize under drought',
				publications: [
					{
						publicationPUI: '10.1234/example',
						publicationReference: 'Roe R, Poe P. A drought paper.'
					}
				],
				datasetAuthorships: [{ license: 'CC-BY-4.0' }],
				additionalInfo: { miappeVersion: '1.1' },
				externalReferences: [],
				programDbId: null
			});
			expect(typeof theTrial.trialDbId).toBe('string');
		});

		it("lists the trial's contacts with their identity fields", async () => {
			const [theTrial] = await data(trialsGET);
			const byName = Object.fromEntries(
				theTrial.contacts.map((c: { name: string }) => [c.name, c])
			);
			expect(Object.keys(byName).sort()).toEqual(['Pat Poe', 'Quinn Quill', 'Rich Roe']);
			expect(byName['Rich Roe']).toMatchObject({
				orcid: ROE_ORCID,
				email: 'rich.roe@example.org',
				type: 'Principal investigator',
				instituteName: 'Example Institute'
			});
			expect(byName['Quinn Quill']).toMatchObject({ orcid: null, email: null });
			expect(typeof byName['Rich Roe'].contactDbId).toBe('string');
		});

		it('filters by name, contact and study, and returns nothing when they do not match', async () => {
			expect(await data(trialsGET, { trialName: 'Drought trial' })).toHaveLength(1);
			expect(await data(trialsGET, { trialName: 'Beta trial' })).toHaveLength(0);

			const [rich] = await t.db.select().from(contact).where(eq(contact.orcid, ROE_ORCID));
			expect(await data(trialsGET, { contactDbId: rich.id })).toHaveLength(1);
			const [bea] = await t.db
				.select()
				.from(contact)
				.where(eq(contact.email, 'bea.beta@example.org'));
			expect(await data(trialsGET, { contactDbId: bea.id })).toHaveLength(0);

			const [s1] = await t.db.select().from(study).where(eq(study.sourceId, 'S1'));
			expect(await data(trialsGET, { studyDbId: s1.id })).toHaveLength(1);
		});

		it('rejects invalid active, sortBy, sortOrder and date parameters with 400', async () => {
			for (const query of <Record<string, string>[]>[
				{ active: 'maybe' },
				{ sortBy: 'colour' },
				{ sortOrder: 'sideways' },
				{ searchDateRangeStart: '01.01.2024' },
				{ searchDateRangeEnd: 'soon' }
			]) {
				expect((await get(trialsGET, query)).status, JSON.stringify(query)).toBe(400);
			}
		});

		it('accepts every documented sortBy value and either sort order', async () => {
			for (const sortBy of [
				'trialDbId',
				'trialName',
				'programDbId',
				'programName',
				'startDate',
				'endDate',
				'locationDbId'
			]) {
				for (const sortOrder of ['asc', 'DESC']) {
					expect(
						(await get(trialsGET, { sortBy, sortOrder })).status,
						`${sortBy} ${sortOrder}`
					).toBe(200);
				}
			}
		});
	});

	describe('GET /studies', () => {
		it("returns the ARC's studies with BrAPI study fields, links and reshaped values", async () => {
			const studies = await data(studiesGET, { sortBy: 'studyName' });
			expect(studies.map((s: { studyName: string }) => s.studyName)).toEqual([
				'Field run',
				'Greenhouse run'
			]);
			const greenhouse = studies[1];
			expect(greenhouse).toMatchObject({
				studyCode: 'S1',
				studyDescription: 'First study',
				startDate: '2024-03-01',
				endDate: '2024-05-30',
				culturalPractices: 'Watered twice a week',
				trialName: 'Drought trial',
				locationName: 'Site X',
				observationLevels: [
					{ levelName: 'field', levelOrder: 0 },
					{ levelName: 'plot', levelOrder: 1 },
					{ levelName: 'plant', levelOrder: 2 }
				],
				seasons: [],
				dataLinks: [],
				environmentParameters: [],
				observationVariableDbIds: []
			});
			expect(typeof greenhouse.studyDbId).toBe('string');
			expect(greenhouse.trialDbId).toEqual(studies[0].trialDbId);
			expect(greenhouse.contacts.map((c: { name: string }) => c.name).sort()).toEqual([
				'Ona Orc',
				'Rich Roe'
			]);
			expect(studies[0].locationDbId).toBeNull();
			expect(studies[0].locationName).toBeNull();
		});

		it('sorts by studyName ascending and descending', async () => {
			const names = async (sortOrder: string) =>
				(await data(studiesGET, { sortBy: 'studyName', sortOrder })).map(
					(s: { studyName: string }) => s.studyName
				);
			expect(await names('asc')).toEqual(['Field run', 'Greenhouse run']);
			expect(await names('desc')).toEqual(['Greenhouse run', 'Field run']);
		});

		it('pages through the sorted list without gaps or repeats', async () => {
			const page = async (n: number) =>
				(await data(studiesGET, { sortBy: 'studyName', pageSize: 1, page: n })).map(
					(s: { studyName: string }) => s.studyName
				);
			expect([...(await page(0)), ...(await page(1)), ...(await page(2))]).toEqual([
				'Field run',
				'Greenhouse run'
			]);
		});

		it('filters by name, code, type-independent ids and location', async () => {
			expect(await data(studiesGET, { studyName: 'Field run' })).toHaveLength(1);
			expect(await data(studiesGET, { studyCode: 'S1' })).toHaveLength(1);
			expect(await data(studiesGET, { studyCode: 'B1' })).toHaveLength(0); // beta's code
			const [site] = await t.db.select().from(location).where(eq(location.name, 'Site X'));
			const atSite = await data(studiesGET, { locationDbId: site.id });
			expect(atSite.map((s: { studyCode: string }) => s.studyCode)).toEqual(['S1']);
			const [seedA] = await t.db
				.select()
				.from(germplasm)
				.where(eq(germplasm.germplasmPui, '1:Seed-A'));
			expect(
				(await data(studiesGET, { germplasmDbId: seedA.id })).map(
					(s: { studyCode: string }) => s.studyCode
				)
			).toEqual(['S1']);
		});

		it('rejects invalid sortBy, sortOrder and active with 400', async () => {
			for (const query of <Record<string, string>[]>[
				{ sortBy: 'colour' },
				{ sortOrder: 'up' },
				{ active: 'yes' }
			]) {
				expect((await get(studiesGET, query)).status, JSON.stringify(query)).toBe(400);
			}
		});
	});

	describe('GET /locations', () => {
		it('returns the location with its GeoJSON point in [longitude, latitude] order', async () => {
			const [site] = await data(locationsGET);
			expect(site).toMatchObject({
				locationName: 'Site X',
				instituteName: 'Example Institute',
				countryName: 'Germany',
				coordinates: { type: 'Feature', geometry: { type: 'Point', coordinates: [11.3, 51.8] } },
				externalReferences: [],
				additionalInfo: {},
				parentLocationDbId: null
			});
		});

		it('filters by name and type', async () => {
			expect(await data(locationsGET, { locationName: 'Site X' })).toHaveLength(1);
			expect(await data(locationsGET, { locationName: 'Site Y' })).toHaveLength(0);
			expect(await data(locationsGET, { locationType: 'Field' })).toHaveLength(0);
		});
	});

	describe('GET /observationunits', () => {
		it('returns units with their study, trial, location and germplasm names', async () => {
			const units = await data(observationUnitsGET);
			expect(
				units.map((u: { observationUnitName: string }) => u.observationUnitName).sort()
			).toEqual(['Plot-1', 'Plot-2']);
			const plot1 = units.find(
				(u: { observationUnitName: string }) => u.observationUnitName === 'Plot-1'
			);
			expect(plot1).toMatchObject({
				studyName: 'Greenhouse run',
				trialName: 'Drought trial',
				locationName: 'Site X',
				germplasmName: 'Seed-A',
				observationUnitPosition: { observationLevel: { levelName: 'plot' } },
				treatments: [],
				externalReferences: []
			});
			expect(typeof plot1.studyDbId).toBe('string');
			expect(typeof plot1.germplasmDbId).toBe('string');
		});

		it('filters by name, level and germplasm', async () => {
			expect(await data(observationUnitsGET, { observationUnitName: 'Plot-2' })).toHaveLength(1);
			expect(await data(observationUnitsGET, { observationUnitName: 'Beta-Plot-1' })).toHaveLength(
				0
			);
			expect(await data(observationUnitsGET, { observationUnitLevelName: 'plot' })).toHaveLength(2);
			expect(await data(observationUnitsGET, { observationUnitLevelName: 'plant' })).toHaveLength(
				0
			);
			const [seedB] = await t.db
				.select()
				.from(germplasm)
				.where(eq(germplasm.germplasmPui, '1:Seed-B'));
			const forSeedB = await data(observationUnitsGET, { germplasmDbId: seedB.id });
			expect(forSeedB.map((u: { observationUnitName: string }) => u.observationUnitName)).toEqual([
				'Plot-2'
			]);
		});
	});

	describe('GET /germplasm', () => {
		it("returns the ARC's germplasm with taxonomy and PUI", async () => {
			const rows = await data(germplasmGET, {});
			const byName = Object.fromEntries(
				rows.map((g: { germplasmName: string }) => [g.germplasmName, g])
			);
			expect(Object.keys(byName).sort()).toEqual(['Seed-A', 'Seed-B']);
			expect(byName['Seed-A']).toMatchObject({
				germplasmPUI: '1:Seed-A',
				genus: 'Zea',
				species: 'mays',
				donors: [],
				synonyms: [],
				externalReferences: []
			});
		});

		it("does not show another ARC's germplasm even when the accession name is the same", async () => {
			// gamma also has a "Seed-A" (PUI 3:Seed-A); alpha must only ever see its own
			const puis = (await data(germplasmGET)).map((g: { germplasmPUI: string }) => g.germplasmPUI);
			expect(puis.sort()).toEqual(['1:Seed-A', '1:Seed-B']);
			expect(
				(await data(germplasmGET, {}, REPOS.gamma)).map(
					(g: { germplasmPUI: string }) => g.germplasmPUI
				)
			).toEqual(['3:Seed-A']);
		});

		it('filters by name, genus, species and binomial name', async () => {
			expect(await data(germplasmGET, { germplasmName: 'Seed-B' })).toHaveLength(1);
			expect(await data(germplasmGET, { genus: 'Zea' })).toHaveLength(1);
			expect(await data(germplasmGET, { species: 'vulgare' })).toHaveLength(1);
			expect(await data(germplasmGET, { binomialName: 'Hordeum vulgare' })).toHaveLength(1);
			expect(await data(germplasmGET, { binomialName: 'Oryza sativa' })).toHaveLength(0); // beta's
		});
	});

	describe('GET /serverinfo', () => {
		it('returns the calls this server implements in the single-result envelope', async () => {
			const { status, body } = await get(serverinfoGET);
			expect(status).toBe(200);
			expect(body.metadata).toEqual({ datafiles: [], status: [] });
			for (const call of body.result.calls) {
				expect(call).toEqual({
					service: expect.any(String),
					methods: ['GET'],
					versions: ['2.1'],
					contentTypes: expect.any(Array)
				});
			}
			const services = body.result.calls.map((c: { service: string }) => c.service);
			expect(services).toEqual(
				expect.arrayContaining(['serverinfo', 'trials', 'studies', 'locations', 'observationunits'])
			);
		});

		it('filters calls by contentType, and rejects an unknown one with 400', async () => {
			const json = await get(serverinfoGET, { contentType: 'application/json' });
			expect(json.body.result.calls.length).toBeGreaterThan(0);
			const csv = await get(serverinfoGET, { contentType: 'text/csv' });
			expect(csv.body.result.calls).toEqual([]);
			expect((await get(serverinfoGET, { contentType: 'application/pdf' })).status).toBe(400);
		});

		// BUG (found in S2.10): /serverinfo is how BrAPI clients discover what a server supports, but it
		// does not advertise `germplasm` and `germplasm/{germplasmDbId}/mcpd`, which are implemented.
		// The expected list is derived from the route directories, so a new endpoint without a CALLS
		// entry fails here. Remove `.fails` when the list is complete.
		it.fails('advertises every endpoint that is implemented', async () => {
			const implemented = Object.keys(import.meta.glob('./**/+server.ts'))
				.map((p) =>
					p
						.replace(/^\.\//, '')
						.replace(/\/\+server\.ts$/, '')
						.replace(/\[(\w+)\]/g, '{$1}')
				)
				.sort();
			const services = (await get(serverinfoGET)).body.result.calls.map(
				(c: { service: string }) => c.service
			);
			expect(services.sort()).toEqual(implemented);
		});
	});

	describe('ids that are not UUIDs', () => {
		// BUG (found in S2.10): an id filter that is not a UUID reaches Postgres, which rejects it, and the
		// client gets a 500. A BrAPI client asking for an unknown id should get an empty list (or 400/404),
		// never a server error. Affects every *DbId filter. Remove `.fails` when fixed.
		it.fails(
			'answers an unknown, non-UUID id filter with an empty list or a 4xx, not a 500',
			async () => {
				const res = await get(studiesGET, { studyDbId: 'not-a-uuid' });
				expect(res.status).toBeLessThan(500);
			}
		);
	});
});
