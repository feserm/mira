import { count, countDistinct, eq, inArray } from 'drizzle-orm';
import { db } from './index';
import {
	cross,
	crossingProject,
	event,
	image,
	observation,
	observationUnit,
	pedigreeNode,
	plannedCross,
	seedLot,
	study,
	studyObservationVariable,
	studySeason,
	trial
} from './schema';

export type BrapiTableCount = {
	name: string;
	count: number;
};

type ArcScopedTable =
	| typeof trial
	| typeof study
	| typeof observationUnit
	| typeof observation
	| typeof image
	| typeof event
	| typeof crossingProject
	| typeof cross
	| typeof plannedCross
	| typeof pedigreeNode
	| typeof seedLot;

const arcScopedTables = [
	['Trials', trial],
	['Studies', study],
	['Observation units', observationUnit],
	['Observations', observation],
	['Seed lots', seedLot],
	['Crosses', cross],
	['Crossing projects', crossingProject],
	['Planned crosses', plannedCross],
	['Pedigree nodes', pedigreeNode],
	['Images', image],
	['Events', event]
] as const satisfies readonly [string, ArcScopedTable][];

/** Shared reference tables that no ARC owns. A row is counted for a viewer only if it is referenced by
 *  an ARC the viewer can read (the same membership the BrAPI list endpoints use), so a count never
 *  includes rows that only an inaccessible ARC brought in. Tables with no such link today (breeding
 *  methods, traits, methods, scales, ontologies, lists, people, germplasm attributes) are not shown
 *  to anyone: a global count of them would include inaccessible ARCs. Add one here together with the
 *  way to attribute its rows to an ARC. */
const sharedTables = [
	[
		'Germplasm',
		(arcIds: number[]) =>
			db
				.select({ count: countDistinct(observationUnit.germplasmId) })
				.from(observationUnit)
				.where(inArray(observationUnit.arcId, arcIds))
	],
	[
		'Locations',
		(arcIds: number[]) =>
			db
				.select({ count: countDistinct(study.locationId) })
				.from(study)
				.where(inArray(study.arcId, arcIds))
	],
	[
		'Programs',
		(arcIds: number[]) =>
			db
				.select({ count: countDistinct(trial.programId) })
				.from(trial)
				.where(inArray(trial.arcId, arcIds))
	],
	[
		'Seasons',
		(arcIds: number[]) =>
			db
				.select({ count: countDistinct(studySeason.seasonId) })
				.from(studySeason)
				.innerJoin(study, eq(studySeason.studyId, study.id))
				.where(inArray(study.arcId, arcIds))
	],
	[
		'Observation variables',
		(arcIds: number[]) =>
			db
				.select({ count: countDistinct(studyObservationVariable.observationVariableId) })
				.from(studyObservationVariable)
				.innerJoin(study, eq(studyObservationVariable.studyId, study.id))
				.where(inArray(study.arcId, arcIds))
	]
] as const;

/** Row counts over exactly the ARCs in `arcIds` (the ARCs the viewer can read; see
 *  `dashboard-access.ts`). No ARC, no rows: every count is 0 and nothing is queried. */
export async function getBrapiTableCounts(arcIds: number[]): Promise<BrapiTableCount[]> {
	if (arcIds.length === 0) {
		return [...arcScopedTables, ...sharedTables].map(([name]) => ({ name, count: 0 }));
	}

	const counts = await Promise.all(
		arcScopedTables.map(async ([name, table]) => {
			const [row] = await db
				.select({ count: count() })
				.from(table)
				.where(inArray(table.arcId, arcIds));
			return { name, count: row.count };
		})
	);

	const sharedCounts = await Promise.all(
		sharedTables.map(async ([name, query]) => {
			const [row] = await query(arcIds);
			return { name, count: Number(row.count) };
		})
	);

	return [...counts, ...sharedCounts];
}
