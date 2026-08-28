import { getTableColumns, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from '$lib/server/db';
import {
	trial,
	contact,
	trialContact,
	study,
	studyContact,
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
import type { NewContact } from '$lib/types/brapi/core';
import type { TransformResult } from './transform';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ArcScopedTable = PgTable & { id: PgColumn; arcId: PgColumn; sourceId: PgColumn };

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
// sourceId is returned alongside id so callers can resolve a specific upserted row by its
// natural (arcId, sourceId) key instead of trusting RETURNING to preserve input row order.
async function upsertArcScoped(
	tx: Tx,
	table: ArcScopedTable,
	rows: Record<string, unknown>[]
): Promise<{ id: string; sourceId: string | null }[]> {
	if (rows.length === 0) return [];
	return tx
		.insert(table)
		.values(rows as never[])
		.onConflictDoUpdate({
			target: [table.arcId, table.sourceId],
			set: conflictUpdateSet(table) as never
		})
		.returning({ id: table.id as never, sourceId: table.sourceId as never }) as Promise<
		{ id: string; sourceId: string | null }[]
	>;
}

/**
 * Contacts are shared reference rows, not arc-scoped: they dedupe globally, preferring ORCID,
 * then email, then name + institute — in that order of how reliably ISA-Tab contacts actually
 * carry each one (ORCID is rare, email usually present, name always present). Nulls never
 * conflict in Postgres, so each tier only kicks in once the row lacks every identifier above
 * it (see the partial unique index backing the name+institute tier). Upserted one row at a
 * time — a batch RETURNING has no reliable key to correlate a returned row back to its input
 * row when several contacts in the same batch share no identifier, so linking them to the
 * right trial/study would be guesswork.
 */
async function upsertContact(tx: Tx, row: NewContact): Promise<string> {
	const insert = tx.insert(contact).values(row);
	const conflict = row.orcid
		? { target: contact.orcid }
		: row.email
			? { target: contact.email }
			: row.name
				? {
						target: [contact.name, contact.instituteName],
						targetWhere: sql`${contact.orcid} is null and ${contact.email} is null`
					}
				: undefined;
	const [{ id }] = await (
		conflict
			? insert.onConflictDoUpdate({ ...conflict, set: conflictUpdateSet(contact) as never })
			: insert
	).returning({ id: contact.id });
	return id;
}

/**
 * Persists a Transform stage result into the arc-scoped BrAPI tables, upserting on
 * (arc_id, source_id). Studies are attached to the ARC's single trial, and contacts
 * (globally deduped — see upsertContact) are linked to their owning trial or study via
 * trial_contact / study_contact. Other shared/reference entities (germplasm, location,
 * program, ...) are out of scope — see transform.ts for why.
 */
export async function loadEntities(result: TransformResult): Promise<void> {
	await db.transaction(async (tx) => {
		const trialRows = await upsertArcScoped(tx, trial, result.trials);

		// transformRoCrate emits investigation-level contacts and studies, which belong to
		// that investigation's single trial (exactly one trial per ARC by construction).
		// Fail loudly rather than silently drop or mislink them if that ever changes.
		const needsTrial = result.contacts.length > 0 || result.studies.length > 0;
		if (needsTrial && trialRows.length !== 1) {
			throw new Error(
				`Expected exactly one trial to attach studies/contacts to, got ${trialRows.length}`
			);
		}
		const trialId = trialRows[0]?.id;

		for (const contactRow of result.contacts) {
			const contactId = await upsertContact(tx, contactRow);
			await tx
				.insert(trialContact)
				.values({ trialId: trialId!, contactId })
				.onConflictDoNothing({ target: [trialContact.trialId, trialContact.contactId] });
		}

		const studyRows = await upsertArcScoped(
			tx,
			study,
			result.studies.map((s) => ({ ...s, trialId }))
		);
		const studyIdBySourceId = new Map(studyRows.map((s) => [s.sourceId, s.id]));

		for (const { studySourceId, contact: contactRow } of result.studyContacts) {
			const studyId = studyIdBySourceId.get(studySourceId);
			if (!studyId) {
				throw new Error(`Study "${studySourceId}" not found while linking its contacts`);
			}
			const contactId = await upsertContact(tx, contactRow);
			await tx
				.insert(studyContact)
				.values({ studyId, contactId })
				.onConflictDoNothing({ target: [studyContact.studyId, studyContact.contactId] });
		}

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
