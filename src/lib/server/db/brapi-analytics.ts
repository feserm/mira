import { count, eq } from 'drizzle-orm';
import { db } from './index';
import {
	breedingMethod,
	cross,
	crossingProject,
	event,
	germplasm,
	germplasmAttribute,
	image,
	location,
	list,
	method,
	observation,
	observationUnit,
	observationVariable,
	ontology,
	pedigreeNode,
	person,
	plannedCross,
	program,
	scale,
	season,
	seedLot,
	study,
	trait,
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

const globalTables = [
	['Germplasm', germplasm],
	['Germplasm attributes', germplasmAttribute],
	['Observation variables', observationVariable],
	['Programs', program],
	['Locations', location],
	['Breeding methods', breedingMethod],
	['Traits', trait],
	['Methods', method],
	['Scales', scale],
	['Ontologies', ontology],
	['Lists', list],
	['People', person],
	['Seasons', season]
] as const;

export async function getBrapiTableCounts(arcId?: number): Promise<BrapiTableCount[]> {
	const counts = await Promise.all(
		arcScopedTables.map(async ([name, table]) => {
			const query = db.select({ count: count() }).from(table);
			const [row] = arcId === undefined ? await query : await query.where(eq(table.arcId, arcId));
			return { name, count: row.count };
		})
	);

	const globalCounts = await Promise.all(
		globalTables.map(async ([name, table]) => {
			const [row] = await db.select({ count: count() }).from(table);
			return { name, count: row.count };
		})
	);

	return [...counts, ...globalCounts];
}
