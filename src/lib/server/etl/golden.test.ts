import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { transformRoCrate } from './transform';
import { loadEntities } from './load';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import {
	ENTITY_TABLES,
	resetData,
	rowIds,
	stageArc,
	tableCounts
} from '$lib/server/test-support/seed';

// A real ARC (the IPK Phenosphere maize benchmark, 4380 graph nodes), kept as one golden fixture next
// to the generated ones. The e-mail addresses and ORCIDs of the two registered contacts were replaced
// by placeholders; names, the publication and the data are as published. The raw file is
// fixtures/phenosphere-ro-crate.json.
const FIXTURE = new URL('../test-support/fixtures/phenosphere-ro-crate.json', import.meta.url);
const raw = readFileSync(FIXTURE, 'utf8');
const crate = () => JSON.parse(raw) as Record<string, unknown>;

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);

const ARC_ID = 11;

describe('golden fixture: a real RO-Crate', () => {
	beforeAll(() => {
		// NCBI is best-effort and must not be reached from a test.
		vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 500 }));
	});
	afterAll(() => vi.unstubAllGlobals());

	it('carries no real contact details', () => {
		expect(raw).not.toMatch(/ipk-gatersleben\.de/);
		expect(raw).toMatch(/0000-0000-0000-000[12]/);
	});

	describe('Transform', () => {
		// Parsing the crate takes seconds, so the tests below share one run.
		let r: Awaited<ReturnType<typeof transformRoCrate>>;
		beforeAll(async () => {
			r = await transformRoCrate(crate(), ARC_ID);
		}, 60_000);

		it('maps the investigation to one trial', async () => {
			expect(r.trials).toHaveLength(1);
			expect(r.trials[0]).toMatchObject({
				arcId: ARC_ID,
				sourceId: 'phenosphere-benchmark',
				name: 'Phenosphere Maize Benchmark Experiment'
			});
			expect(r.trials[0].publications?.[0]).toMatchObject({
				publicationPUI: '10.1038/s41467-023-41332-4'
			});
		});

		it('maps the seven studies, each with its dates, location and both contacts', async () => {
			expect(r.studies.map((s) => s.sourceId).sort()).toEqual([
				'field2016',
				'field2017',
				'field2018',
				'field2019',
				'glasshouse',
				'phenosphere2016Sim',
				'phenosphereAvg'
			]);
			const field2016 = r.studies.find((s) => s.sourceId === 'field2016')!;
			expect([field2016.startDate, field2016.endDate]).toEqual(['2016-04-27', '2016-09-13']);
			expect(r.locations).toHaveLength(7);
			expect(r.studyLocations).toHaveLength(7);
			expect(r.studyContacts).toHaveLength(14);
		});

		it('keeps the registered contacts, with the anonymised identifiers', async () => {
			expect(r.contacts.map((c) => [c.email, c.orcid]).sort()).toEqual([
				['person.one@example.org', '0000-0000-0000-0001'],
				['person.two@example.org', '0000-0000-0000-0002']
			]);
		});

		it('maps 11 maize accessions and ties every observation unit to its study and germplasm', async () => {
			expect(r.germplasm).toHaveLength(11);
			expect(r.germplasm.every((g) => g.genus === 'Zea' && g.species === 'Zea mays')).toBe(true);
			expect(r.germplasm.every((g) => g.germplasmPui)).toBe(true);
			expect(r.observationUnits).toHaveLength(1035);
			expect(r.studyObservationUnits).toHaveLength(1035);
			expect(r.observationUnitGermplasm).toHaveLength(1035);
			expect(new Set(r.observationUnits.map((u) => u.sourceId)).size).toBe(1035);
		});

		it(
			'is deterministic: transforming twice gives the same entities',
			{ timeout: 60_000 },
			async () => {
				const strip = (r: Awaited<ReturnType<typeof transformRoCrate>>) =>
					JSON.stringify({
						trials: r.trials,
						studies: r.studies,
						contacts: r.contacts,
						germplasm: r.germplasm,
						units: r.observationUnits
					});
				expect(strip(await transformRoCrate(crate(), ARC_ID))).toBe(
					strip(await transformRoCrate(crate(), ARC_ID))
				);
			}
		);
	});

	describe.skipIf(!hasTestDb)('Load (real Postgres, DML-only role)', { timeout: 120_000 }, () => {
		let t: DmlTestDb;
		beforeAll(async () => {
			t = await createDmlTestDb();
			useTestDb(t.db);
		});
		afterAll(async () => {
			useTestDb(undefined);
			await t?.drop();
		});
		beforeEach(async () => {
			await resetData(t.db);
		});

		const importIt = async (mutate?: (c: Record<string, unknown>) => void) => {
			await stageArc(t.db, ARC_ID, 'group/phenosphere', t.userId);
			const c = crate();
			mutate?.(c);
			await loadEntities(await transformRoCrate(c, ARC_ID), ARC_ID);
		};

		it('writes the whole ARC', async () => {
			await importIt();
			const c = await tableCounts(t.db);
			expect({
				trial: c.trial,
				study: c.study,
				contact: c.contact,
				trial_contact: c.trial_contact,
				study_contact: c.study_contact,
				location: c.location,
				germplasm: c.germplasm,
				observation_unit: c.observation_unit
			}).toEqual({
				trial: 1,
				study: 7,
				contact: 3, // the two registered contacts plus a study-only contact
				trial_contact: 2,
				study_contact: 14,
				location: 3, // seven study locations, three distinct sites
				germplasm: 11,
				observation_unit: 1035
			});
		});

		it('re-importing the same ARC leaves every count and row id unchanged', async () => {
			await importIt();
			const counts = await tableCounts(t.db);
			const ids = await rowIds(t.db, ENTITY_TABLES);
			await importIt();
			expect(await tableCounts(t.db)).toEqual(counts);
			expect(await rowIds(t.db, ENTITY_TABLES)).toEqual(ids);
		});

		it('prunes a study, and its observation units, that was removed from the ARC', async () => {
			await importIt();
			const before = await tableCounts(t.db);
			await importIt((c) => {
				const graph = c['@graph'] as Record<string, unknown>[];
				const gone = 'studies/field2019/';
				const withoutRef = (v: unknown) =>
					Array.isArray(v) ? v.filter((x) => (x as { '@id'?: string })?.['@id'] !== gone) : v;
				c['@graph'] = graph
					.filter((n) => n['@id'] !== gone)
					.map((n) => (n['hasPart'] ? { ...n, hasPart: withoutRef(n['hasPart']) } : n));
			});
			const after = await tableCounts(t.db);
			expect(after.study).toBe(before.study - 1);
			expect(after.contact).toBe(before.contact);
			expect(after.germplasm).toBe(before.germplasm);
		});
	});
});

placeholderWithoutDb('Golden fixture: Load (real Postgres, DML-only role)');
