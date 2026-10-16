/** Three imported ARCs for the BrAPI handler tests, seeded through the real Transform and Load:
 *  - alpha: the default fixture (site X, germplasm Seed-A/Seed-B)
 *  - beta: different studies, site and germplasm; shares one contact (Rich Roe) with alpha
 *  - gamma: a different ARC that uses the same site X as alpha (a shared location row)
 *  Names are chosen so that data of one ARC is recognisable inside another ARC's response. */
import { arcSpec, GREENHOUSE_COMMENTS, ROE, type ArcSpec, type PersonSpec } from './arc-fixtures';
import type { DmlTestDb } from './dml-db';
import { importArc } from './seed';

export const BETA_PERSON: PersonSpec = {
	firstName: 'Bea',
	lastName: 'Beta',
	email: 'bea.beta@example.org',
	affiliation: 'Beta Institute'
};

export const REPOS = {
	alpha: 'Group/Alpha',
	beta: 'Group/Beta',
	gamma: 'Group/Gamma'
} as const;

export const ARC_IDS = { alpha: 1, beta: 2, gamma: 3 } as const;

const betaSpec: ArcSpec = arcSpec({
	identifier: 'INV-BETA',
	title: 'Beta trial',
	contacts: [ROE, BETA_PERSON],
	studies: [
		{
			identifier: 'B1',
			title: 'Beta study one',
			comments: {
				...GREENHOUSE_COMMENTS,
				'Experimental site name': 'Site Y',
				'Contact institution': 'Beta Institute'
			},
			contacts: [BETA_PERSON],
			materials: [{ source: 'Seed-C', genus: 'Oryza', species: 'sativa', sample: 'Beta-Plot-1' }]
		},
		{ identifier: 'B2', title: 'Beta study two' }
	]
});

const gammaSpec: ArcSpec = arcSpec({
	identifier: 'INV-GAMMA',
	title: 'Gamma trial',
	studies: [
		{
			identifier: 'G1',
			title: 'Gamma study one',
			comments: GREENHOUSE_COMMENTS,
			materials: [{ source: 'Seed-A', genus: 'Zea', species: 'mays', sample: 'Gamma-Plot-1' }]
		}
	]
});

export async function seedBrapiFixture(t: DmlTestDb) {
	const opts = { userId: t.userId };
	await importArc(t.db, { arcId: ARC_IDS.alpha, path: REPOS.alpha, spec: arcSpec(), ...opts });
	await importArc(t.db, { arcId: ARC_IDS.beta, path: REPOS.beta, spec: betaSpec, ...opts });
	await importArc(t.db, { arcId: ARC_IDS.gamma, path: REPOS.gamma, spec: gammaSpec, ...opts });
}
