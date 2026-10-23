import { and, eq, getTableColumns, inArray, notInArray, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from '$lib/server/db';
import {
	trial,
	contact,
	trialContact,
	study,
	studyContact,
	location,
	germplasm,
	observationUnit,
	observation,
	image,
	event
} from '$lib/server/db/schema';
import type { NewContact, NewLocation } from '$lib/types/brapi/core';
import type { NewGermplasm } from '$lib/types/brapi/germplasm';
import type { NewObservationUnit } from '$lib/types/brapi/phenotyping';
import type { TransformResult } from './transform';
import { lockArc } from './queue';

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
 * The ARC is the source of truth, so an arc-scoped row whose source id is no longer in the import
 * was removed from the ARC and must stop being served. Contacts, locations and germplasm are shared
 * with other ARCs and are never deleted here; only their links to this ARC are pruned.
 */
async function pruneArcScoped(
	tx: Tx,
	table: ArcScopedTable,
	arcId: number,
	keep: (string | null | undefined)[]
): Promise<void> {
	const ids = keep.filter((id): id is string => !!id);
	await tx
		.delete(table)
		.where(and(eq(table.arcId, arcId), ids.length ? notInArray(table.sourceId, ids) : undefined));
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
	// A contact first imported without an ORCID and since given one has no ORCID match, but its
	// email row exists: the plain insert below would hit the unique email constraint and abort the
	// whole Load. Update that row (it gains the ORCID) instead.
	if (row.orcid && row.email) {
		const [byOrcid] = await tx
			.select({ id: contact.id })
			.from(contact)
			.where(eq(contact.orcid, row.orcid));
		if (!byOrcid) {
			const [byEmail] = await tx
				.update(contact)
				.set(row)
				.where(eq(contact.email, row.email))
				.returning({ id: contact.id });
			if (byEmail) return byEmail.id;
		}
	}
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
 * Locations are shared reference rows, not arc-scoped (like contacts): they dedupe globally
 * on (name, instituteName), the unique constraint backing this table — there's no ORCID/email
 * equivalent for a location, so that's the only tier. Studies hold their location via a plain
 * `locationId` FK column (not a join table, since a study has at most one location), so this
 * must resolve before the study row is built rather than linked afterward like study_contact.
 */
async function upsertLocation(tx: Tx, row: NewLocation): Promise<string> {
	const [{ id }] = await tx
		.insert(location)
		.values(row)
		.onConflictDoUpdate({
			target: [location.name, location.instituteName],
			set: conflictUpdateSet(location) as never
		})
		.returning({ id: location.id });
	return id;
}

/**
 * Germplasm is a shared reference row, not arc-scoped (like contact/location): the same
 * accession can be reused across ARCs, so it dedupes globally on germplasmPui, the one
 * MIAPPE-independent identifier transform.ts always fills in (falling back to a synthetic
 * `${arcId}:${sourceId}` when the source data has no external reference id — see transform.ts).
 */
async function upsertGermplasm(tx: Tx, row: NewGermplasm): Promise<string> {
	const [{ id }] = await tx
		.insert(germplasm)
		.values(row)
		.onConflictDoUpdate({
			target: germplasm.germplasmPui,
			set: conflictUpdateSet(germplasm) as never
		})
		.returning({ id: germplasm.id });
	return id;
}

/**
 * Persists a Transform stage result into the arc-scoped BrAPI tables, upserting on
 * (arc_id, source_id). Studies are attached to the ARC's single trial, and contacts
 * (globally deduped — see upsertContact) are linked to their owning trial or study via
 * trial_contact / study_contact; locations (also globally deduped — see upsertLocation)
 * are linked via study.locationId. Germplasm (also globally deduped — see upsertGermplasm) is
 * upserted standalone. Observation units are linked to their owning study via studyId, resolved
 * from result.studyObservationUnits now that studies have an id, to the germplasm they were
 * sampled from via germplasmId, resolved from result.observationUnitGermplasm now that germplasm
 * has an id, to the ARC's single trial via trialId, taken directly from trialId above (no link
 * array needed, unlike studyId/germplasmId, since every observation unit belongs to the same one
 * trial), and to a location via locationId, inherited from its study's location (looked up in
 * locationIdByStudySourceId by the same studySourceId, since an observation unit has no location
 * of its own in the source data). Other shared/reference entities (program, ...) are out of scope
 * — see transform.ts for why.
 */
export async function loadEntities(result: TransformResult, arcId: number): Promise<void> {
	await db.transaction(async (tx) => {
		// One Load per ARC at a time, even if two workers briefly believe they own the same job.
		await lockArc(tx, arcId);

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

		const trialContactIds: string[] = [];
		for (const contactRow of result.contacts) {
			const contactId = await upsertContact(tx, contactRow);
			trialContactIds.push(contactId);
			await tx
				.insert(trialContact)
				.values({ trialId: trialId!, contactId })
				.onConflictDoNothing({ target: [trialContact.trialId, trialContact.contactId] });
		}

		// A NewLocation object is shared by reference between result.locations and its
		// StudyLocationLink (see transform.ts), so a WeakMap keyed on that reference is enough
		// to carry the upserted id from one to the other without a natural business key.
		const locationIdByRow = new WeakMap<NewLocation, string>();
		for (const locationRow of result.locations) {
			locationIdByRow.set(locationRow, await upsertLocation(tx, locationRow));
		}
		const locationIdByStudySourceId = new Map(
			result.studyLocations.map(({ studySourceId, location: locationRow }) => [
				studySourceId,
				locationIdByRow.get(locationRow)
			])
		);

		const studyRows = await upsertArcScoped(
			tx,
			study,
			result.studies.map((s) => ({
				...s,
				trialId,
				locationId: (s.sourceId && locationIdByStudySourceId.get(s.sourceId)) ?? null
			}))
		);
		const studyIdBySourceId = new Map(studyRows.map((s) => [s.sourceId, s.id]));

		const studyContactKeys = new Set<string>();
		for (const { studySourceId, contact: contactRow } of result.studyContacts) {
			const studyId = studyIdBySourceId.get(studySourceId);
			if (!studyId) {
				throw new Error(`Study "${studySourceId}" not found while linking its contacts`);
			}
			const contactId = await upsertContact(tx, contactRow);
			studyContactKeys.add(`${studyId}:${contactId}`);
			await tx
				.insert(studyContact)
				.values({ studyId, contactId })
				.onConflictDoNothing({ target: [studyContact.studyId, studyContact.contactId] });
		}

		// A NewGermplasm object is shared by reference between result.germplasm and its
		// ObservationUnitGermplasmLink entries (see transform.ts), same WeakMap-by-reference
		// pattern as locationIdByRow above, since germplasm has no arc-scoped sourceId of its own
		// to key a plain Map by (it dedupes globally on germplasmPui instead).
		const germplasmIdByRow = new WeakMap<NewGermplasm, string>();
		for (const germplasmRow of result.germplasm) {
			germplasmIdByRow.set(germplasmRow, await upsertGermplasm(tx, germplasmRow));
		}

		// Studies are already upserted above, so (unlike study.locationId) each observation unit's
		// studyId can be resolved directly off studyIdBySourceId -- the WeakMap here only carries
		// that resolved id from result.studyObservationUnits (keyed by object reference, same as
		// locationIdByRow above, since a NewObservationUnit row has no natural key of its own yet)
		// across to the row itself just before insert.
		const studyIdByObservationUnitRow = new WeakMap<NewObservationUnit, string>();
		for (const { studySourceId, observationUnit: unitRow } of result.studyObservationUnits) {
			const studyId = studyIdBySourceId.get(studySourceId);
			if (!studyId) {
				throw new Error(`Study "${studySourceId}" not found while linking its observation units`);
			}
			studyIdByObservationUnitRow.set(unitRow, studyId);
		}
		const germplasmIdByObservationUnitRow = new WeakMap<NewObservationUnit, string>();
		for (const {
			observationUnit: unitRow,
			germplasm: germplasmRow
		} of result.observationUnitGermplasm) {
			const germplasmId = germplasmIdByRow.get(germplasmRow);
			if (germplasmId) germplasmIdByObservationUnitRow.set(unitRow, germplasmId);
		}

		// Reuses locationIdByStudySourceId (built above for study.locationId) rather than
		// re-deriving it from result.studyLocations -- an observation unit's location is just its
		// study's location, so it only needs to be looked up via the same studySourceId already
		// carried by result.studyObservationUnits.
		const locationIdByObservationUnitRow = new WeakMap<NewObservationUnit, string>();
		for (const { studySourceId, observationUnit: unitRow } of result.studyObservationUnits) {
			const locationId = locationIdByStudySourceId.get(studySourceId);
			if (locationId) locationIdByObservationUnitRow.set(unitRow, locationId);
		}
		await upsertArcScoped(
			tx,
			observationUnit,
			result.observationUnits.map((row) => ({
				...row,
				studyId: studyIdByObservationUnitRow.get(row) ?? null,
				germplasmId: germplasmIdByObservationUnitRow.get(row) ?? null,
				// Every observation unit belongs to the ARC's single trial (exactly one trial per
				// ARC by construction, same invariant the contacts/studies attachment above relies
				// on), so trialId is just the trial upserted at the top of this transaction --
				// unlike studyId/germplasmId, no per-row link array is needed to resolve it.
				trialId: trialId ?? null,
				locationId: locationIdByObservationUnitRow.get(row) ?? null
			}))
		);
		await upsertArcScoped(tx, observation, result.observations);
		await upsertArcScoped(tx, image, result.images);
		await upsertArcScoped(tx, event, result.events);

		// Prune what the ARC no longer contains, children before parents (observation units and
		// observations reference their study without a cascade).
		await pruneArcScoped(
			tx,
			observation,
			arcId,
			result.observations.map((r) => r.sourceId)
		);
		await pruneArcScoped(
			tx,
			image,
			arcId,
			result.images.map((r) => r.sourceId)
		);
		await pruneArcScoped(
			tx,
			event,
			arcId,
			result.events.map((r) => r.sourceId)
		);
		await pruneArcScoped(
			tx,
			observationUnit,
			arcId,
			result.observationUnits.map((r) => r.sourceId)
		);
		await pruneArcScoped(
			tx,
			study,
			arcId,
			result.studies.map((r) => r.sourceId)
		);

		// Contact links of this ARC's trial and studies (a study deleted above took its links with it).
		if (trialId) {
			await tx
				.delete(trialContact)
				.where(
					and(
						eq(trialContact.trialId, trialId),
						trialContactIds.length ? notInArray(trialContact.contactId, trialContactIds) : undefined
					)
				);
		}
		const arcStudyIds = [...studyIdBySourceId.values()];
		if (arcStudyIds.length) {
			const existing = await tx
				.select()
				.from(studyContact)
				.where(inArray(studyContact.studyId, arcStudyIds));
			for (const link of existing) {
				if (studyContactKeys.has(`${link.studyId}:${link.contactId}`)) continue;
				await tx
					.delete(studyContact)
					.where(
						and(eq(studyContact.studyId, link.studyId), eq(studyContact.contactId, link.contactId))
					);
			}
		}
	});
}
