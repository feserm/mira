import { error } from '@sveltejs/kit';
import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lte,
	or,
	type AnyColumn
} from 'drizzle-orm';
import { db } from '$lib/server/db';
import { trial, program, trialContact, contact, study } from '$lib/server/db/schema';
import { resolveReadableArc } from '$lib/server/brapi/arc';
import type { BrapiTrial, BrapiContact } from '$lib/types/brapi/core';
import {
	brapiJson,
	brapiListResponse,
	parseBrapiPagination,
	hasMalformedDbId
} from '$lib/server/brapi/response';
import { authenticateBrapi } from '$lib/server/brapi/auth';
import type { RequestHandler } from './$types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Columns GET /trials can sort by. `locationDbId` is a valid BrAPI sortBy value but lives
 * on `study`, not `trial` — sorting by it would require joining/aggregating studies per
 * trial, so it falls back to the default sort instead of being wired up speculatively.
 */
const SORT_COLUMNS: Partial<Record<string, AnyColumn>> = {
	trialDbId: trial.id,
	trialName: trial.name,
	programDbId: trial.programId,
	programName: program.name,
	startDate: trial.startDate,
	endDate: trial.endDate
};
const VALID_SORT_BY = [...Object.keys(SORT_COLUMNS), 'locationDbId'];

function parseActive(value: string | null): boolean | undefined {
	if (value === null) return undefined;
	if (value === 'true') return true;
	if (value === 'false') return false;
	error(400, `Invalid active: "${value}"`);
}

function parseDate(param: string, value: string | null): string | undefined {
	if (value === null) return undefined;
	if (!ISO_DATE.test(value)) error(400, `Invalid ${param}: "${value}"`);
	return value;
}

export const GET: RequestHandler = async (event) => {
	await authenticateBrapi(event);

	const arcId = await resolveReadableArc(event);

	const params = event.url.searchParams;
	const { page, pageSize } = parseBrapiPagination(params);
	if (hasMalformedDbId(params)) return brapiJson(brapiListResponse([], page, pageSize, 0));

	const trialDbId = params.get('trialDbId');
	const trialName = params.get('trialName');
	const trialPUI = params.get('trialPUI');
	const programDbId = params.get('programDbId');
	const commonCropName = params.get('commonCropName');
	const contactDbId = params.get('contactDbId');
	const studyDbId = params.get('studyDbId');
	const locationDbId = params.get('locationDbId');
	const active = parseActive(params.get('active'));
	const searchDateRangeStart = parseDate(
		'searchDateRangeStart',
		params.get('searchDateRangeStart')
	);
	const searchDateRangeEnd = parseDate('searchDateRangeEnd', params.get('searchDateRangeEnd'));

	const sortByParam = params.get('sortBy');
	if (sortByParam && !VALID_SORT_BY.includes(sortByParam))
		error(400, `Invalid sortBy: "${sortByParam}"`);
	const sortColumn = (sortByParam && SORT_COLUMNS[sortByParam]) || trial.id;

	const sortOrderParam = (params.get('sortOrder') ?? 'asc').toLowerCase();
	if (sortOrderParam !== 'asc' && sortOrderParam !== 'desc')
		error(400, `Invalid sortOrder: "${params.get('sortOrder')}"`);

	const studyFilter =
		studyDbId || locationDbId
			? inArray(
					trial.id,
					db
						.select({ id: study.trialId })
						.from(study)
						.where(
							and(
								studyDbId ? eq(study.id, studyDbId) : undefined,
								locationDbId ? eq(study.locationId, locationDbId) : undefined
							)
						)
				)
			: undefined;

	const where = and(
		eq(trial.arcId, arcId),
		trialDbId ? eq(trial.id, trialDbId) : undefined,
		trialName ? eq(trial.name, trialName) : undefined,
		trialPUI ? eq(trial.trialPui, trialPUI) : undefined,
		programDbId ? eq(trial.programId, programDbId) : undefined,
		commonCropName ? eq(trial.commonCropName, commonCropName) : undefined,
		active !== undefined ? eq(trial.active, active) : undefined,
		contactDbId
			? inArray(
					trial.id,
					db
						.select({ id: trialContact.trialId })
						.from(trialContact)
						.where(eq(trialContact.contactId, contactDbId))
				)
			: undefined,
		studyFilter,
		searchDateRangeStart
			? or(isNull(trial.endDate), gte(trial.endDate, searchDateRangeStart))
			: undefined,
		searchDateRangeEnd
			? or(isNull(trial.startDate), lte(trial.startDate, searchDateRangeEnd))
			: undefined
	);

	const [rows, [{ totalCount }]] = await Promise.all([
		db
			.select({ trial, programName: program.name })
			.from(trial)
			.leftJoin(program, eq(trial.programId, program.id))
			.where(where)
			.orderBy(sortOrderParam === 'desc' ? desc(sortColumn) : asc(sortColumn))
			.limit(pageSize)
			.offset(page * pageSize),
		db.select({ totalCount: count() }).from(trial).where(where)
	]);

	const trialIds = rows.map((row) => row.trial.id);
	const contactRows = trialIds.length
		? await db
				.select({ trialId: trialContact.trialId, contact })
				.from(trialContact)
				.innerJoin(contact, eq(trialContact.contactId, contact.id))
				.where(inArray(trialContact.trialId, trialIds))
		: [];

	const contactsByTrial = new Map<string, BrapiContact[]>();
	for (const row of contactRows) {
		const contacts = contactsByTrial.get(row.trialId) ?? [];
		contacts.push({
			contactDbId: row.contact.id,
			name: row.contact.name,
			email: row.contact.email,
			instituteName: row.contact.instituteName,
			orcid: row.contact.orcid,
			type: row.contact.type
		});
		contactsByTrial.set(row.trialId, contacts);
	}

	const data: BrapiTrial[] = rows.map(({ trial: t, programName }) => ({
		trialDbId: t.id,
		trialName: t.name,
		trialDescription: t.description,
		trialPUI: t.trialPui,
		active: t.active,
		commonCropName: t.commonCropName,
		documentationURL: t.documentationUrl,
		startDate: t.startDate,
		endDate: t.endDate,
		programDbId: t.programId,
		programName,
		contacts: contactsByTrial.get(t.id) ?? [],
		publications: t.publications ?? [],
		datasetAuthorships: t.datasetAuthorships ?? [],
		externalReferences: t.externalReferences ?? [],
		additionalInfo: t.additionalInfo ?? {}
	}));

	return brapiJson(brapiListResponse(data, page, pageSize, totalCount));
};
