import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
	contact,
	germplasm,
	location,
	observationUnit,
	study,
	trial,
	trialContact
} from '$lib/server/db/schema';
import {
	arcSpec,
	GREENHOUSE_COMMENTS,
	ORCID_ONLY,
	POE,
	QUILL,
	ROE,
	roCrate,
	type ArcSpec
} from '$lib/server/test-support/arc-fixtures';
import { useTestDb } from '$lib/server/test-support/db-mock';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import {
	ENTITY_TABLES,
	importArc,
	resetData,
	rowIds,
	stageArc,
	tableCounts
} from '$lib/server/test-support/seed';
import { waitFor } from '$lib/server/test-support/wait';
import { loadEntities } from './load';
import { lockArc } from './queue';
import { transformRoCrate, type TransformResult } from './transform';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);

const emptyResult = (over: Partial<TransformResult> = {}): TransformResult => ({
	trials: [],
	studies: [],
	contacts: [],
	studyContacts: [],
	locations: [],
	studyLocations: [],
	germplasm: [],
	observationUnits: [],
	studyObservationUnits: [],
	observationUnitGermplasm: [],
	observationVariables: [],
	observations: [],
	images: [],
	events: [],
	...over
});

/** A result with one trial and the given investigation contacts: the smallest valid Load. */
const trialWithContacts = (arcId: number, contacts: TransformResult['contacts']) =>
	emptyResult({ trials: [{ arcId, sourceId: `T${arcId}`, name: `Trial ${arcId}` }], contacts });

// Real Postgres, as the DML-only app role. Set TEST_DATABASE_URL to run (docs/testing.md).
describe.skipIf(!hasTestDb)('Load (real Postgres, DML-only role)', () => {
	let t: DmlTestDb;

	beforeAll(async () => {
		// Transform asks NCBI for a crop name; fail fast and offline.
		vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 500 }));
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
	});

	const count = async (table: string) => (await tableCounts(t.db))[table];
	const importFixture = (arcId: number, spec?: ArcSpec) =>
		importArc(t.db, { arcId, path: `group/arc-${arcId}`, spec, userId: t.userId });

	describe('what one import writes', () => {
		it('writes the fixture ARC into the entity tables and links them', async () => {
			await importFixture(1);
			const counts = await tableCounts(t.db);
			expect(counts).toMatchObject({
				trial: 1,
				study: 2,
				contact: 4, // Rich, Pat, Quinn, Ona: Rich and Pat appear twice in the ARC but once here
				trial_contact: 3,
				study_contact: 3,
				location: 1,
				germplasm: 2,
				observation_unit: 2
			});

			const [s1] = await t.db.select().from(study).where(eq(study.sourceId, 'S1'));
			const [s2] = await t.db.select().from(study).where(eq(study.sourceId, 'S2'));
			const [site] = await t.db.select().from(location);
			expect(s1.locationId).toBe(site.id);
			expect(s2.locationId).toBeNull();

			const units = await t.db.select().from(observationUnit);
			const [seedA] = await t.db
				.select()
				.from(germplasm)
				.where(sql`${germplasm.germplasmName} = 'Seed-A'`);
			const plot1 = units.find((u) => u.sourceId === 'Plot-1')!;
			const [theTrial] = await t.db.select().from(trial);
			expect(plot1).toMatchObject({
				studyId: s1.id,
				germplasmId: seedA.id,
				locationId: site.id,
				trialId: theTrial.id,
				arcId: 1
			});
			expect(s1.trialId).toBe(theTrial.id);
		});

		it('refuses studies without exactly one trial, and writes nothing', async () => {
			await stageArc(t.db, 1, 'group/arc-1');
			const orphan = emptyResult({
				studies: [{ arcId: 1, sourceId: 'S1', name: 'S1' }]
			});
			await expect(loadEntities(orphan, 1)).rejects.toThrow(/exactly one trial/);
			expect(await count('study')).toBe(0);
		});
	});

	describe('idempotency', () => {
		it('importing the same ARC twice leaves every table unchanged, with the same row ids', async () => {
			await importFixture(1);
			const countsAfterFirst = await tableCounts(t.db);
			const idsAfterFirst = await rowIds(t.db, ENTITY_TABLES);
			// guard against a vacuous test: something was actually written
			expect(countsAfterFirst.study).toBeGreaterThan(0);
			expect(idsAfterFirst.contact.length).toBeGreaterThan(0);

			await importFixture(1);

			expect(await tableCounts(t.db)).toEqual(countsAfterFirst);
			expect(await rowIds(t.db, ENTITY_TABLES)).toEqual(idsAfterFirst);
		});

		it('importing ten times in a row is still the same data', async () => {
			await importFixture(1);
			const counts = await tableCounts(t.db);
			for (let i = 0; i < 9; i++) await importFixture(1);
			expect(await tableCounts(t.db)).toEqual(counts);
		});

		it('updates changed fields in place instead of adding rows', async () => {
			await importFixture(1);
			const countsBefore = await tableCounts(t.db);
			const idsBefore = await rowIds(t.db, ENTITY_TABLES);

			const changed = arcSpec({ title: 'Drought trial (revised)' });
			changed.studies[0] = {
				...changed.studies[0],
				title: 'Greenhouse run (revised)',
				comments: { ...GREENHOUSE_COMMENTS, 'End date of study': '2024-06-15' },
				materials: [
					{ source: 'Seed-A', genus: 'Zea', species: 'mexicana', sample: 'Plot-1' },
					{ source: 'Seed-B', genus: 'Hordeum', species: 'vulgare', sample: 'Plot-2' }
				]
			};
			// same ORCID, new e-mail: the same person, so the same contact row. Rich appears twice in the
			// ARC (investigation and S1), and the last occurrence wins, so both carry the new e-mail.
			const richNow = { ...ROE, email: 'rich.roe@new.example.org' };
			changed.contacts = [richNow, POE, QUILL];
			changed.studies[0].contacts = [richNow, ORCID_ONLY];
			await importFixture(1, changed);

			expect(await tableCounts(t.db)).toEqual(countsBefore);
			expect(await rowIds(t.db, ENTITY_TABLES)).toEqual(idsBefore);

			const [theTrial] = await t.db.select().from(trial);
			const [s1] = await t.db.select().from(study).where(eq(study.sourceId, 'S1'));
			const [seedA] = await t.db
				.select()
				.from(germplasm)
				.where(sql`${germplasm.germplasmName} = 'Seed-A'`);
			const [rich] = await t.db.select().from(contact).where(eq(contact.orcid, ROE.orcid!));
			expect(theTrial.name).toBe('Drought trial (revised)');
			expect(s1).toMatchObject({ name: 'Greenhouse run (revised)', endDate: '2024-06-15' });
			expect(seedA.species).toBe('mexicana');
			expect(rich.email).toBe('rich.roe@new.example.org');
		});

		// DESIGN QUESTION (found in S2.10): Load only upserts. A study (or contact link) removed from the
		// ARC stays in the database and keeps being served by the BrAPI endpoints. If keeping removed data
		// is intended, delete this test and document it; otherwise Load needs a prune step. Remove `.fails`
		// when decided.
		it.fails('removes a study that was deleted from the ARC on re-import', async () => {
			await importFixture(1);
			const withoutS2 = arcSpec();
			withoutS2.studies = withoutS2.studies.filter((s) => s.identifier !== 'S2');
			await importFixture(1, withoutS2);
			expect(await count('study')).toBe(1);
		});
	});

	describe('sharing between ARCs', () => {
		it('shares contacts and locations across ARCs but keeps arc-scoped rows apart', async () => {
			await importFixture(1);
			const contactsAfterOne = await rowIds(t.db, ['contact', 'location']);
			await importFixture(2, arcSpec({ identifier: 'INV2', title: 'Second trial' }));

			const counts = await tableCounts(t.db);
			// shared reference rows: not duplicated
			expect(counts.contact).toBe(4);
			expect(counts.location).toBe(1);
			expect(await rowIds(t.db, ['contact', 'location'])).toEqual(contactsAfterOne);
			// arc-scoped rows: one set per ARC, even though both ARCs call their studies S1 and S2
			expect(counts.trial).toBe(2);
			expect(counts.study).toBe(4);
			expect(counts.observation_unit).toBe(4);
			// the links are per ARC, pointing at the one shared contact
			expect(counts.trial_contact).toBe(6);
			const [rich] = await t.db.select().from(contact).where(eq(contact.orcid, ROE.orcid!));
			const links = await t.db
				.select()
				.from(trialContact)
				.where(eq(trialContact.contactId, rich.id));
			expect(new Set(links.map((l) => l.trialId)).size).toBe(2);
		});

		// Pins current behaviour: with no external reference, a germplasm PUI is `${arcId}:${source}`, so
		// the same accession name in two ARCs is two germplasm rows, not one shared row.
		it('does not share germplasm between ARCs when the PUI is the synthetic one', async () => {
			await importFixture(1);
			await importFixture(2, arcSpec({ identifier: 'INV2' }));
			const puis = (await t.db.select({ pui: germplasm.germplasmPui }).from(germplasm)).map(
				(g) => g.pui
			);
			expect(puis.sort()).toEqual(['1:Seed-A', '1:Seed-B', '2:Seed-A', '2:Seed-B']);
		});

		it('keeps arc-scoped rows of one ARC intact when another ARC is re-imported', async () => {
			await importFixture(1);
			await importFixture(2, arcSpec({ identifier: 'INV2' }));
			const arcOne = await t.db.select().from(study).where(eq(study.arcId, 1));
			await importFixture(2, arcSpec({ identifier: 'INV2', title: 'Renamed' }));
			expect(await t.db.select().from(study).where(eq(study.arcId, 1))).toEqual(arcOne);
		});
	});

	describe('contact identity: ORCID, then e-mail, then name + institute', () => {
		const load = async (arcId: number, contacts: TransformResult['contacts']) => {
			await stageArc(t.db, arcId, `group/arc-${arcId}`);
			await loadEntities(trialWithContacts(arcId, contacts), arcId);
		};

		it('treats the same ORCID as the same person even when e-mail and name differ', async () => {
			await load(1, [{ name: 'R. Roe', orcid: ROE.orcid, email: 'old@example.org' }]);
			await load(2, [{ name: 'Rich Roe', orcid: ROE.orcid, email: 'new@example.org' }]);
			const rows = await t.db.select().from(contact);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ name: 'Rich Roe', email: 'new@example.org' });
		});

		it('treats the same e-mail as the same person when there is no ORCID', async () => {
			await load(1, [{ name: 'P. Poe', email: POE.email }]);
			await load(2, [{ name: 'Pat Poe', email: POE.email, instituteName: 'Example Institute' }]);
			const rows = await t.db.select().from(contact);
			expect(rows).toHaveLength(1);
			expect(rows[0].name).toBe('Pat Poe');
		});

		it('treats the same name and institute as the same person when there is no ORCID or e-mail', async () => {
			await load(1, [
				{ name: QUILL.firstName + ' ' + QUILL.lastName, instituteName: 'Sample Station' }
			]);
			await load(2, [
				{ name: QUILL.firstName + ' ' + QUILL.lastName, instituteName: 'Sample Station' }
			]);
			expect(await count('contact')).toBe(1);
		});

		it('keeps people apart: same name at another institute, different ORCIDs, different e-mails', async () => {
			await load(1, [
				{ name: 'Sam Same', instituteName: 'Institute A' },
				{ name: 'Sam Same', instituteName: 'Institute B' },
				{ name: 'Sam Same', orcid: '0000-0003-0000-0001', instituteName: 'Institute A' },
				{ name: 'Sam Same', orcid: '0000-0003-0000-0002', instituteName: 'Institute A' },
				{ name: 'Sam Same', email: 'sam1@example.org', instituteName: 'Institute A' },
				{ name: 'Sam Same', email: 'sam2@example.org', instituteName: 'Institute A' }
			]);
			expect(await count('contact')).toBe(6);
		});

		it('links one shared contact to a trial and to its studies exactly once, however often it repeats', async () => {
			await stageArc(t.db, 1, 'group/arc-1');
			const person = { name: 'Rich Roe', orcid: ROE.orcid, email: ROE.email };
			await loadEntities(
				emptyResult({
					trials: [{ arcId: 1, sourceId: 'T1', name: 'T' }],
					studies: [
						{ arcId: 1, sourceId: 'S1', name: 'S1' },
						{ arcId: 1, sourceId: 'S2', name: 'S2' }
					],
					contacts: [person, person],
					studyContacts: [
						{ studySourceId: 'S1', contact: person },
						{ studySourceId: 'S1', contact: person },
						{ studySourceId: 'S2', contact: person }
					]
				}),
				1
			);
			expect(await count('contact')).toBe(1);
			expect(await count('trial_contact')).toBe(1);
			expect(await count('study_contact')).toBe(2);
		});

		// BUG (found in S2.10): a contact that was imported without an ORCID and later gets one in the ARC
		// makes Load fail permanently. The upsert targets `orcid`, finds no row, tries to INSERT and hits
		// the unique constraint on `email` of the existing row, so the whole transaction aborts with a
		// duplicate key error and the ARC can never be re-imported. Remove `.fails` when fixed.
		it.fails('accepts a contact that gains an ORCID between two imports', async () => {
			await load(1, [{ name: 'Pat Poe', email: POE.email }]);
			await load(1, [{ name: 'Pat Poe', email: POE.email, orcid: '0000-0004-0000-0001' }]);
			expect(await count('contact')).toBe(1);
		});

		it('still links people with no usable name, once per occurrence', async () => {
			await load(1, [{ orcid: ORCID_ONLY.orcid }]);
			expect(await count('trial_contact')).toBe(1);
		});
	});

	describe('atomicity', () => {
		// The last thing Load writes is `event` rows; a row without its NOT NULL event_type fails there,
		// after the trial, contacts, locations, studies and observation units were already written.
		const poisoned = async (spec: ArcSpec, arcId = 1) => {
			const result = await transformRoCrate(roCrate(spec), arcId);
			result.events = [{ arcId, sourceId: 'bad-event' } as never];
			return result;
		};

		it('leaves no partial data when the last write of a first import fails', async () => {
			await stageArc(t.db, 1, 'group/arc-1');
			const before = await tableCounts(t.db);
			await expect(loadEntities(await poisoned(arcSpec()), 1)).rejects.toThrow(
				/event_type|null value/
			);
			expect(await tableCounts(t.db)).toEqual(before);
		});

		it('leaves the previous import untouched when a re-import fails midway', async () => {
			await importFixture(1);
			const counts = await tableCounts(t.db);
			const ids = await rowIds(t.db, ENTITY_TABLES);
			const namesBefore = (
				await t.db.select({ n: study.name }).from(study).orderBy(study.sourceId)
			).map((s) => s.n);

			const changed = arcSpec({ title: 'Should not appear' });
			changed.studies[0] = { ...changed.studies[0], title: 'Should not appear either' };
			changed.contacts = [
				...changed.contacts,
				{ firstName: 'New', lastName: 'Person', email: 'new@example.org' }
			];
			await expect(loadEntities(await poisoned(changed), 1)).rejects.toThrow();

			expect(await tableCounts(t.db)).toEqual(counts);
			expect(await rowIds(t.db, ENTITY_TABLES)).toEqual(ids);
			expect(
				(await t.db.select({ n: study.name }).from(study).orderBy(study.sourceId)).map((s) => s.n)
			).toEqual(namesBefore);
			const [theTrial] = await t.db.select().from(trial);
			expect(theTrial.name).toBe('Drought trial');
		});

		it('a failed Load does not block the next one', async () => {
			await stageArc(t.db, 1, 'group/arc-1');
			await expect(loadEntities(await poisoned(arcSpec()), 1)).rejects.toThrow();
			await loadEntities(await transformRoCrate(roCrate(arcSpec()), 1), 1);
			expect(await count('trial')).toBe(1);
		});
	});

	describe('concurrency', () => {
		const waitingAdvisoryLocks = async () => {
			const [row] = await t.db.execute<{ n: number }>(sql`
				select count(*)::int as n from pg_locks
				where locktype = 'advisory' and not granted
				  and database = (select oid from pg_database where datname = current_database())`);
			return row.n;
		};

		/** Holds the per-ARC Load lock in an open transaction until `release()` is called. */
		async function holdArcLock(arcId: number) {
			let release!: () => void;
			const released = new Promise<void>((r) => (release = r));
			let acquired!: () => void;
			const hasLock = new Promise<void>((r) => (acquired = r));
			const tx = t.db.transaction(async (inner) => {
				await lockArc(inner, arcId);
				acquired();
				await released;
			});
			await hasLock;
			return { release, done: tx };
		}

		it('a Load waits for the per-ARC lock and writes nothing until it is free', async () => {
			await stageArc(t.db, 1, 'group/arc-1');
			const result = await transformRoCrate(roCrate(arcSpec()), 1);
			const holder = await holdArcLock(1);
			let settled = false;
			const load = loadEntities(result, 1).finally(() => (settled = true));
			try {
				await waitFor(
					async () => settled || (await waitingAdvisoryLocks()) > 0,
					'Load to queue on the lock'
				);
				expect(settled).toBe(false);
				expect(await count('trial')).toBe(0);
			} finally {
				holder.release();
				await holder.done;
			}
			await load;
			expect(await count('trial')).toBe(1);
		});

		it('different ARCs do not block each other', async () => {
			await stageArc(t.db, 1, 'group/arc-1');
			await stageArc(t.db, 2, 'group/arc-2');
			const holder = await holdArcLock(1);
			try {
				await loadEntities(await transformRoCrate(roCrate(arcSpec({ identifier: 'INV2' })), 2), 2);
				expect(await count('trial')).toBe(1);
			} finally {
				holder.release();
				await holder.done;
			}
		});

		it('two simultaneous Loads of one ARC end with one consistent version of the data', async () => {
			await stageArc(t.db, 1, 'group/arc-1');
			const version = async (tag: string) => {
				const spec = arcSpec({ title: `trial ${tag}` });
				spec.studies[0] = {
					...spec.studies[0],
					title: `study ${tag}`,
					materials: [{ source: 'Seed-A', genus: 'Zea', species: tag, sample: 'Plot-1' }]
				};
				return transformRoCrate(roCrate(spec), 1);
			};
			const [a, b] = [await version('a'), await version('b')];
			await Promise.all([loadEntities(a, 1), loadEntities(b, 1)]);

			const counts = await tableCounts(t.db);
			expect(counts).toMatchObject({
				trial: 1,
				study: 2,
				contact: 4,
				germplasm: 1,
				observation_unit: 1
			});
			const [theTrial] = await t.db.select().from(trial);
			const [s1] = await t.db
				.select()
				.from(study)
				.where(and(eq(study.arcId, 1), eq(study.sourceId, 'S1')));
			const [seedA] = await t.db
				.select()
				.from(germplasm)
				.where(sql`${germplasm.germplasmName} = 'Seed-A'`);
			const tag = theTrial.name.endsWith('a') ? 'a' : 'b';
			expect([s1.name, seedA.species]).toEqual([`study ${tag}`, tag]);
		});
	});
});
