import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getCrosswalk, transformRoCrate } from './transform';
import {
	arcSpec,
	POE,
	QUILL,
	ROE,
	roCrate,
	type ArcSpec,
	type StudySpec
} from '$lib/server/test-support/arc-fixtures';

describe('getCrosswalk', () => {
	it('loads a non-empty ISA <-> BrAPI crosswalk from the bundled sssom.tsv', () => {
		const entries = getCrosswalk();
		expect(entries.length).toBeGreaterThan(0);
		for (const e of entries) {
			expect(e.isaId).toMatch(/^isa_/);
			expect(e.brapiId).toMatch(/^brapi_/);
		}
	});
});

// Transform looks up a crop's common name at NCBI. The stub knows maize ("mays" or "zea mays") and
// answers 500 for anything else, so the best-effort fallback is exercised and no test touches the
// network. Every requested URL is recorded.
const ncbiRequests: string[] = [];
function ncbiStub(url: string | URL | Request) {
	const u = new URL(String(url));
	ncbiRequests.push(u.toString());
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
	const term = u.searchParams.get('term')?.toLowerCase();
	if (u.pathname.endsWith('esearch.fcgi') && /^(zea )?mays\[scientific name\]$/.test(term ?? ''))
		return json({ esearchresult: { idlist: ['4577'] } });
	if (u.pathname.endsWith('esummary.fcgi') && u.searchParams.get('id') === '4577')
		return json({ result: { '4577': { commonname: 'maize' } } });
	return new Response('unavailable', { status: 500 });
}

const ARC_ID = 7;
const transform = (spec: ArcSpec = arcSpec(), arcId = ARC_ID) =>
	transformRoCrate(roCrate(spec), arcId);

describe('transformRoCrate', () => {
	beforeAll(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL | Request) => ncbiStub(url))
		);
	});
	afterAll(() => {
		vi.unstubAllGlobals();
	});

	describe('investigation -> trial', () => {
		it('maps the crosswalk fields (identifier, title, description) and tags the ARC', async () => {
			const { trials } = await transform();
			expect(trials).toHaveLength(1);
			expect(trials[0]).toMatchObject({
				arcId: ARC_ID,
				sourceId: 'INV1',
				name: 'Drought trial',
				description: 'Barley and maize under drought'
			});
		});

		it('reads license and MIAPPE version from ISA comments into the hand-shaped fields', async () => {
			const [trial] = (await transform()).trials;
			expect(trial.datasetAuthorships).toEqual([{ license: 'CC-BY-4.0' }]);
			expect(trial.additionalInfo).toEqual({ miappeVersion: '1.1' });
		});

		it('formats the publication: DOI from the crosswalk, citation by hand', async () => {
			const [trial] = (await transform()).trials;
			expect(trial.publications).toEqual([
				{
					publicationPUI: '10.1234/example',
					publicationReference: 'Roe R, Poe P. A drought paper.'
				}
			]);
		});

		it('cites at most six authors, then "et al"', async () => {
			const authors = 'A, B, C, D, E, F, G, H';
			const [trial] = (
				await transform(arcSpec({ publications: [{ doi: '10.1/x', authors, title: 'T.' }] }))
			).trials;
			expect(trial.publications?.[0].publicationReference).toBe('A, B, C, D, E, F, et al. T.');
		});

		it('still yields one dataset-authorship entry and no extra keys without license or version', async () => {
			const [trial] = (await transform(arcSpec({ comments: {}, publications: [] }))).trials;
			expect(trial.datasetAuthorships).toEqual([{}]);
			expect(trial.publications).toEqual([]);
			expect(trial.additionalInfo).toBeUndefined();
		});

		// BUG (found in S2.10): the investigation's submission and public-release dates never reach the
		// trial. ARCtrl 3.2.0 does not write them into the RO-Crate (and the reader does not restore
		// them), so `datasetAuthorships[0].submissionDate/publicReleaseDate` stay empty for every real
		// ARC although sssom.tsv and the registries in transform.ts map them. Remove `.fails` when fixed.
		it.fails('maps submission and public release date into datasetAuthorships', async () => {
			const [trial] = (await transform()).trials;
			expect(trial.datasetAuthorships?.[0]).toMatchObject({
				submissionDate: '2024-01-01',
				publicReleaseDate: '2024-06-01'
			});
		});
	});

	describe('studies and locations', () => {
		it('emits one study per ISA study with its identifier as source id and study code', async () => {
			const { studies } = await transform();
			expect(studies.map((s) => [s.sourceId, s.studyCode, s.name])).toEqual([
				['S1', 'S1', 'Greenhouse run'],
				['S2', 'S2', 'Field run']
			]);
			expect(studies.every((s) => s.arcId === ARC_ID)).toBe(true);
		});

		it('maps the comment-based study fields and reshapes the observation level hierarchy', async () => {
			const [s1] = (await transform()).studies;
			expect(s1).toMatchObject({
				description: 'First study',
				startDate: '2024-03-01',
				endDate: '2024-05-30',
				culturalPractices: 'Watered twice a week',
				observationLevels: [
					{ levelName: 'field', levelOrder: 0 },
					{ levelName: 'plot', levelOrder: 1 },
					{ levelName: 'plant', levelOrder: 2 }
				]
			});
		});

		it('leaves optional fields absent (not null, not empty) when the ISA study lacks them', async () => {
			const s2 = (await transform()).studies[1];
			for (const key of [
				'startDate',
				'endDate',
				'culturalPractices',
				'observationLevels',
				'description'
			]) {
				expect(s2, key).not.toHaveProperty(key);
			}
		});

		it('falls back to the identifier when a study has no title', async () => {
			const untitled: StudySpec = { identifier: 'S9', title: '' };
			const { studies } = await transform(arcSpec({ studies: [untitled] }));
			expect(studies[0].name).toBe('S9');
		});

		it('builds a location only for studies that carry site fields, and links it to that study', async () => {
			const { locations, studyLocations } = await transform();
			expect(locations).toHaveLength(1);
			expect(studyLocations.map((l) => l.studySourceId)).toEqual(['S1']);
			expect(studyLocations[0].location).toBe(locations[0]); // same object: Load relies on identity
			expect(locations[0]).toMatchObject({
				name: 'Site X',
				instituteName: 'Example Institute',
				countryName: 'Germany'
			});
		});

		it('writes coordinates as GeoJSON [longitude, latitude] (and altitude when given)', async () => {
			const { locations } = await transform();
			expect(locations[0].coordinates).toEqual({
				type: 'Feature',
				geometry: { type: 'Point', coordinates: [11.3, 51.8] }
			});
			const withAltitude = arcSpec();
			withAltitude.studies[0] = {
				...withAltitude.studies[0],
				comments: { ...withAltitude.studies[0].comments, 'Geographic location (altitude)': '118' }
			};
			const { locations: located } = await transform(withAltitude);
			expect(located[0].coordinates?.geometry).toMatchObject({ coordinates: [11.3, 51.8, 118] });
		});
	});

	describe('contacts', () => {
		it('maps investigation contacts, with and without ORCID and e-mail', async () => {
			const { contacts } = await transform();
			expect(contacts).toEqual([
				{
					name: 'Rich Roe',
					email: ROE.email,
					orcid: ROE.orcid,
					type: 'Principal investigator',
					instituteName: 'Example Institute'
				},
				{ name: 'Pat Poe', email: POE.email, instituteName: 'Example Institute' },
				{ name: 'Quinn Quill', instituteName: QUILL.affiliation }
			]);
			// absent identifiers are absent, so Load's "name + institute" tier can recognise them
			expect(contacts[2].email ?? null).toBeNull();
			expect(contacts[2].orcid ?? null).toBeNull();
		});

		it('links study contacts to their study by identifier, including one contact in two places', async () => {
			const { studyContacts, contacts } = await transform();
			expect(studyContacts.map((c) => [c.studySourceId, c.contact.name])).toEqual([
				['S1', 'Rich Roe'],
				['S1', 'Ona Orc'],
				['S2', 'Pat Poe']
			]);
			// Rich is both an investigation and a study contact; the identity is the same
			expect(studyContacts[0].contact.orcid).toBe(contacts[0].orcid);
			// an ORCID without e-mail
			expect(studyContacts[1].contact).toMatchObject({ orcid: '0000-0002-0000-0001' });
			expect(studyContacts[1].contact.email ?? null).toBeNull();
		});
	});

	describe('germplasm and observation units', () => {
		it('emits one germplasm row per source accession with genus and species', async () => {
			const { germplasm } = await transform();
			expect(germplasm.map((g) => [g.germplasmName, g.genus, g.species])).toEqual([
				['Seed-A', 'Zea', 'mays'],
				['Seed-B', 'Hordeum', 'vulgare']
			]);
		});

		it('falls back to a synthetic PUI that is unique per ARC and source, and stable across runs', async () => {
			const first = (await transform(arcSpec(), 7)).germplasm.map((g) => g.germplasmPui);
			const again = (await transform(arcSpec(), 7)).germplasm.map((g) => g.germplasmPui);
			const other = (await transform(arcSpec(), 8)).germplasm.map((g) => g.germplasmPui);
			expect(first).toEqual(['7:Seed-A', '7:Seed-B']);
			expect(again).toEqual(first);
			expect(other).toEqual(['8:Seed-A', '8:Seed-B']);
		});

		it('takes the crop name from NCBI when available and leaves it empty when the lookup fails', async () => {
			const { germplasm } = await transform();
			expect(germplasm.map((g) => g.commonCropName)).toEqual(['Maize', '']);
		});

		// BUG (found in S2.10): the lookup sends only the species epithet ("mays"), because genus is a
		// separate characteristic and only `species` is passed on, but the comment on fetchNcbiCommonName
		// says the full binomial is required ("Zea mays"). NCBI matches on the full scientific name, so
		// for MIAPPE-style data (Genus and Species as separate columns) the crop name is mostly empty.
		// A unique species keeps this independent of the per-process lookup cache. Remove `.fails` when fixed.
		it.fails('asks NCBI for the full binomial (genus + species)', async () => {
			const spec = arcSpec();
			spec.studies[0] = {
				...spec.studies[0],
				materials: [{ source: 'Seed-Q', genus: 'Qwertia', species: 'zzzfake', sample: 'Plot-Q' }]
			};
			await transform(spec);
			const terms = ncbiRequests
				.map((u) => new URL(u).searchParams.get('term')?.toLowerCase())
				.filter(Boolean);
			expect(terms).toContain('qwertia zzzfake[scientific name]');
		});

		it('emits one observation unit per sample, typed by its observation level', async () => {
			const { observationUnits } = await transform();
			expect(observationUnits.map((u) => [u.sourceId, u.observationUnitName])).toEqual([
				['Plot-1', 'Plot-1'],
				['Plot-2', 'Plot-2']
			]);
			expect(observationUnits[0].observationUnitPosition?.observationLevel).toEqual({
				levelName: 'plot'
			});
			expect(observationUnits.every((u) => u.arcId === ARC_ID)).toBe(true);
		});

		it('links each observation unit to the germplasm it grew from, and to its study', async () => {
			const r = await transform();
			const byUnit = new Map(
				r.observationUnitGermplasm.map((l) => [l.observationUnit, l.germplasm])
			);
			expect(byUnit.get(r.observationUnits[0])?.germplasmName).toBe('Seed-A');
			expect(byUnit.get(r.observationUnits[1])?.germplasmName).toBe('Seed-B');
			expect(r.studyObservationUnits.map((l) => l.studySourceId)).toEqual(['S1', 'S1']);
		});

		it('emits one germplasm row when two studies use the same accession', async () => {
			const spec = arcSpec();
			spec.studies[1] = {
				...spec.studies[1],
				materials: [{ source: 'Seed-A', genus: 'Zea', species: 'mays', sample: 'Plot-9' }]
			};
			const r = await transform(spec);
			expect(r.germplasm.map((g) => g.germplasmName)).toEqual(['Seed-A', 'Seed-B']);
			expect(r.observationUnits.map((u) => u.sourceId)).toEqual(['Plot-1', 'Plot-2', 'Plot-9']);
		});
	});

	describe('shape and determinism', () => {
		it('is deterministic: the same crate gives the same entities', async () => {
			const crate = roCrate();
			const a = await transformRoCrate(crate, ARC_ID);
			const b = await transformRoCrate(crate, ARC_ID);
			expect(b).toEqual(a);
		});

		it('does not mutate the staged crate it is given', async () => {
			const crate = roCrate();
			const before = JSON.stringify(crate);
			await transformRoCrate(crate, ARC_ID);
			expect(JSON.stringify(crate)).toBe(before);
		});

		it('handles an investigation with no studies and no contacts: one trial, nothing else', async () => {
			const r = await transform(arcSpec({ studies: [], contacts: [] }));
			expect(r.trials).toHaveLength(1);
			for (const key of [
				'studies',
				'contacts',
				'studyContacts',
				'locations',
				'germplasm',
				'observationUnits'
			] as const) {
				expect(r[key], key).toEqual([]);
			}
		});

		// Known gap (docs/testing.md section 6): these are not mapped yet. This pins the current
		// behaviour so that implementing one of them has to update this test deliberately.
		it('does not yet produce observations, variables, images or events', async () => {
			const r = await transform();
			expect([r.observations, r.observationVariables, r.images, r.events]).toEqual([
				[],
				[],
				[],
				[]
			]);
		});
	});

	describe('malformed input', () => {
		const crate = roCrate() as { '@graph': { '@id': string }[] };
		const malformed: [string, unknown][] = [
			['null', null],
			['a string', 'not a crate'],
			['a number', 5],
			['an array', []],
			['an empty object', {}],
			['a crate with an empty graph', { ...crate, '@graph': [] }],
			[
				'a crate without the root dataset',
				{ ...crate, '@graph': crate['@graph'].filter((n) => n['@id'] !== './') }
			]
		];

		it.each(malformed)(
			'rejects %s with a readable parse error and returns no partial result',
			async (_name, input) => {
				await expect(transformRoCrate(input, ARC_ID)).rejects.toThrow(
					/Could not parse ARC-RO-Crate metadata/
				);
			}
		);
	});
});
