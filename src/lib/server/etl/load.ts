import { getTableColumns, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from '$lib/server/db';
import {
	trial,
	study,
	crossingProject,
	cross,
	plannedCross,
	pedigreeNode,
	seedLot,
	seedLotTransaction,
	germplasmAttributeValue,
	observationUnit,
	observation,
	image,
	event
} from '$lib/server/db/schema';
import type { TransformResult } from './transform';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ArcScopedTable = PgTable & { arcId: PgColumn; sourceId: PgColumn };

const IDENTITY_COLUMNS = ['id', 'createdAt', 'arcId', 'sourceId'] as const;

function conflictUpdateSet(table: PgTable) {
	return Object.fromEntries(
		Object.entries(getTableColumns(table))
			.filter(([key]) => !(IDENTITY_COLUMNS as readonly string[]).includes(key))
			.map(([key, column]) => [key, sql.raw(`excluded.${column.name}`)])
	);
}

// Drizzle's column typings don't generalize across heterogeneous PgTables well enough
// for a fully type-checked generic upsert; call sites already pass well-typed NewX[]
// arrays, which is where the type safety that matters actually lives.
async function upsertArcScoped(tx: Tx, table: ArcScopedTable, rows: Record<string, unknown>[]) {
	if (rows.length === 0) return;
	await tx
		.insert(table)
		.values(rows as never[])
		.onConflictDoUpdate({
			target: [table.arcId, table.sourceId],
			set: conflictUpdateSet(table) as never
		});
}

/**
 * Persists a Transform stage result into the arc-scoped BrAPI tables, upserting on
 * (arc_id, source_id). Shared/reference entities (germplasm, location, program, ...)
 * are out of scope — see transform.ts for why.
 */
export async function loadEntities(result: TransformResult): Promise<void> {
	await db.transaction(async (tx) => {
		await upsertArcScoped(tx, trial, result.trials);
		await upsertArcScoped(tx, study, result.studies);
		await upsertArcScoped(tx, crossingProject, result.crossingProjects);
		await upsertArcScoped(tx, cross, result.crosses);
		await upsertArcScoped(tx, plannedCross, result.plannedCrosses);
		await upsertArcScoped(tx, pedigreeNode, result.pedigreeNodes);
		await upsertArcScoped(tx, seedLot, result.seedLots);
		await upsertArcScoped(tx, seedLotTransaction, result.seedLotTransactions);
		await upsertArcScoped(tx, germplasmAttributeValue, result.germplasmAttributeValues);
		await upsertArcScoped(tx, observationUnit, result.observationUnits);
		await upsertArcScoped(tx, observation, result.observations);
		await upsertArcScoped(tx, image, result.images);
		await upsertArcScoped(tx, event, result.events);
	});
}
