/** Seeding and inspecting a test database through the real code paths. Importing this module needs
 *  `$lib/server/db` to be mocked (see db-mock.ts) because it uses the real Load step. */
import { sql } from 'drizzle-orm';
import { roCrateStaging } from '$lib/server/db/schema';
import { loadEntities } from '$lib/server/etl/load';
import { transformRoCrate } from '$lib/server/etl/transform';
import { arcSpec, roCrate, type ArcSpec } from './arc-fixtures';
import type { AppDb } from './dml-db';

/** The `ro_crate_staging` row every arc-scoped table points at (Extract creates it in production). */
export async function stageArc(db: AppDb, arcId: number, path: string, userId?: string) {
	await db
		.insert(roCrateStaging)
		.values({ arcId, path, extractStatus: 'success', extractedBy: userId })
		.onConflictDoUpdate({ target: roCrateStaging.arcId, set: { path } });
}

/** Stage an ARC and run the real Transform and Load on a generated fixture. */
export async function importArc(
	db: AppDb,
	opts: { arcId: number; path: string; spec?: ArcSpec; userId?: string }
) {
	await stageArc(db, opts.arcId, opts.path, opts.userId);
	const result = await transformRoCrate(roCrate(opts.spec ?? arcSpec()), opts.arcId);
	await loadEntities(result, opts.arcId);
	return result;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function publicTables(db: AppDb): Promise<string[]> {
	const rows = await db.execute<{ tablename: string }>(
		sql`select tablename from pg_tables where schemaname = 'public' order by tablename`
	);
	return rows.map((r) => r.tablename);
}

/** Row count of every table in the public schema, by table name. */
export async function tableCounts(db: AppDb): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const table of await publicTables(db)) {
		const [row] = await db.execute<{ n: number }>(
			sql.raw(`select count(*)::int as n from ${quote(table)}`)
		);
		counts[table] = row.n;
	}
	return counts;
}

/** Ids of every row in the given tables, sorted: what "the same row" means across two imports. */
export async function rowIds(db: AppDb, tables: string[]): Promise<Record<string, string[]>> {
	const ids: Record<string, string[]> = {};
	for (const table of tables) {
		const rows = await db.execute<{ id: string }>(
			sql.raw(`select id::text as id from ${quote(table)} order by id`)
		);
		ids[table] = rows.map((r) => r.id);
	}
	return ids;
}

/** Tables the ETL writes entities into, besides `ro_crate_staging` and `etl_job`. */
export const ENTITY_TABLES = [
	'trial',
	'study',
	'contact',
	'trial_contact',
	'study_contact',
	'location',
	'germplasm',
	'observation_unit'
];

/** Removes everything a test may have written (the DML role cannot TRUNCATE), keeping the seeded
 *  user. Fails if any other table still has rows, so a new table cannot silently leak between tests. */
export async function resetData(db: AppDb): Promise<void> {
	// Deleting the staging rows cascades to every arc-scoped table.
	for (const table of ['ro_crate_staging', 'etl_job', 'contact', 'location', 'germplasm']) {
		await db.execute(sql.raw(`delete from ${quote(table)}`));
	}
	const leftovers = Object.entries(await tableCounts(db)).filter(
		([table, n]) => n > 0 && table !== 'user'
	);
	if (leftovers.length) throw new Error(`resetData left rows behind: ${JSON.stringify(leftovers)}`);
}
