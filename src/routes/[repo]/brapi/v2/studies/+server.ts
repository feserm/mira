import { error } from '@sveltejs/kit';
import { and, asc, count, desc, eq, inArray, type AnyColumn } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	study,
	trial,
	program,
	location,
	studyContact,
	contact,
	studySeason,
	season,
	studyObservationVariable,
	observationUnit
} from '$lib/server/db/schema';
import { resolveReadableArc } from '$lib/server/brapi/arc';
import type { BrapiStudy, BrapiContact } from '$lib/types/brapi/core';
import {
	brapiJson,
	brapiListResponse,
	parseBrapiPagination,
	hasMalformedDbId
} from '$lib/server/brapi/response';
import { authenticateBrapi } from '$lib/server/brapi/auth';
import type { RequestHandler } from './$types';

/**
 * Columns GET /studies can sort by. `programDbId`/`programName` live on `trial` (via
 * `study.trialId`), so they need the trial/program joins already present in the query.
 * `seasonDbId`, `germplasmDbId`, and `observationVariableDbId` are many-to-many via join
 * tables and can't be expressed as a single sortable column, so they fall back to the
 * default sort instead of being wired up speculatively.
 */
const SORT_COLUMNS: Partial<Record<string, AnyColumn>> = {
	studyDbId: study.id,
	studyName: study.name,
	trialDbId: study.trialId,
	programDbId: trial.programId,
	programName: program.name,
	locationDbId: study.locationId,
	studyLocation: location.name,
	studyType: study.studyType
};
const VALID_SORT_BY = [
	...Object.keys(SORT_COLUMNS),
	'seasonDbId',
	'germplasmDbId',
	'observationVariableDbId'
];

function parseActive(value: string | null): boolean | undefined {
	if (value === null) return undefined;
	if (value === 'true') return true;
	if (value === 'false') return false;
	error(400, `Invalid active: "${value}"`);
}

export const GET: RequestHandler = async (event) => {
	await authenticateBrapi(event);

	const arcId = await resolveReadableArc(event);

	const params = event.url.searchParams;
	const { page, pageSize } = parseBrapiPagination(params);
	if (hasMalformedDbId(params)) return brapiJson(brapiListResponse([], page, pageSize, 0));

	const commonCropName = params.get('commonCropName');
	const germplasmDbId = params.get('germplasmDbId');
	const locationDbId = params.get('locationDbId');
	const programDbId = params.get('programDbId');
	const studyDbId = params.get('studyDbId');
	const studyName = params.get('studyName');
	const trialDbId = params.get('trialDbId');
	const observationVariableDbId = params.get('observationVariableDbId');
	const seasonDbId = params.get('seasonDbId');
	const studyType = params.get('studyType');
	const studyCode = params.get('studyCode');
	const studyPUI = params.get('studyPUI');
	const active = parseActive(params.get('active'));

	const sortByParam = params.get('sortBy');
	if (sortByParam && !VALID_SORT_BY.includes(sortByParam))
		error(400, `Invalid sortBy: "${sortByParam}"`);
	const sortColumn = (sortByParam && SORT_COLUMNS[sortByParam]) || study.id;

	const sortOrderParam = (params.get('sortOrder') ?? 'asc').toLowerCase();
	if (sortOrderParam !== 'asc' && sortOrderParam !== 'desc')
		error(400, `Invalid sortOrder: "${params.get('sortOrder')}"`);

	const where = and(
		eq(study.arcId, arcId),
		commonCropName ? eq(study.commonCropName, commonCropName) : undefined,
		locationDbId ? eq(study.locationId, locationDbId) : undefined,
		programDbId ? eq(trial.programId, programDbId) : undefined,
		studyDbId ? eq(study.id, studyDbId) : undefined,
		studyName ? eq(study.name, studyName) : undefined,
		trialDbId ? eq(study.trialId, trialDbId) : undefined,
		studyType ? eq(study.studyType, studyType) : undefined,
		studyCode ? eq(study.studyCode, studyCode) : undefined,
		studyPUI ? eq(study.studyPui, studyPUI) : undefined,
		active !== undefined ? eq(study.active, active) : undefined,
		germplasmDbId
			? inArray(
					study.id,
					db
						.select({ id: observationUnit.studyId })
						.from(observationUnit)
						.where(eq(observationUnit.germplasmId, germplasmDbId))
				)
			: undefined,
		observationVariableDbId
			? inArray(
					study.id,
					db
						.select({ id: studyObservationVariable.studyId })
						.from(studyObservationVariable)
						.where(eq(studyObservationVariable.observationVariableId, observationVariableDbId))
				)
			: undefined,
		seasonDbId
			? inArray(
					study.id,
					db
						.select({ id: studySeason.studyId })
						.from(studySeason)
						.where(eq(studySeason.seasonId, seasonDbId))
				)
			: undefined
	);

	const [rows, [{ totalCount }]] = await Promise.all([
		db
			.select({
				study,
				trialName: trial.name,
				locationName: location.name
			})
			.from(study)
			.leftJoin(trial, eq(study.trialId, trial.id))
			.leftJoin(program, eq(trial.programId, program.id))
			.leftJoin(location, eq(study.locationId, location.id))
			.where(where)
			.orderBy(sortOrderParam === 'desc' ? desc(sortColumn) : asc(sortColumn))
			.limit(pageSize)
			.offset(page * pageSize),
		db
			.select({ totalCount: count() })
			.from(study)
			.leftJoin(trial, eq(study.trialId, trial.id))
			.where(where)
	]);

	const studyIds = rows.map((row) => row.study.id);

	const [contactRows, seasonRows, variableRows] = await Promise.all([
		studyIds.length
			? db
					.select({ studyId: studyContact.studyId, contact })
					.from(studyContact)
					.innerJoin(contact, eq(studyContact.contactId, contact.id))
					.where(inArray(studyContact.studyId, studyIds))
			: [],
		studyIds.length
			? db
					.select({ studyId: studySeason.studyId, seasonName: season.seasonName })
					.from(studySeason)
					.innerJoin(season, eq(studySeason.seasonId, season.id))
					.where(inArray(studySeason.studyId, studyIds))
			: [],
		studyIds.length
			? db
					.select({
						studyId: studyObservationVariable.studyId,
						observationVariableId: studyObservationVariable.observationVariableId
					})
					.from(studyObservationVariable)
					.where(inArray(studyObservationVariable.studyId, studyIds))
			: []
	]);

	const contactsByStudy = new Map<string, BrapiContact[]>();
	for (const row of contactRows) {
		const contacts = contactsByStudy.get(row.studyId) ?? [];
		contacts.push({
			contactDbId: row.contact.id,
			name: row.contact.name,
			email: row.contact.email,
			instituteName: row.contact.instituteName,
			orcid: row.contact.orcid,
			type: row.contact.type
		});
		contactsByStudy.set(row.studyId, contacts);
	}

	const seasonsByStudy = new Map<string, string[]>();
	for (const row of seasonRows) {
		if (!row.seasonName) continue;
		const seasons = seasonsByStudy.get(row.studyId) ?? [];
		seasons.push(row.seasonName);
		seasonsByStudy.set(row.studyId, seasons);
	}

	const variablesByStudy = new Map<string, string[]>();
	for (const row of variableRows) {
		const variables = variablesByStudy.get(row.studyId) ?? [];
		variables.push(row.observationVariableId);
		variablesByStudy.set(row.studyId, variables);
	}

	const data: BrapiStudy[] = rows.map(({ study: s, trialName, locationName }) => ({
		studyDbId: s.id,
		studyName: s.name,
		studyDescription: s.description,
		studyCode: s.studyCode,
		studyPUI: s.studyPui,
		studyType: s.studyType,
		commonCropName: s.commonCropName,
		active: s.active,
		startDate: s.startDate,
		endDate: s.endDate,
		culturalPractices: s.culturalPractices,
		documentationURL: s.documentationUrl,
		license: s.license,
		observationUnitsDescription: s.observationUnitsDescription,
		observationLevels: s.observationLevels ?? [],
		observationVariableDbIds: variablesByStudy.get(s.id) ?? [],
		experimentalDesign: s.experimentalDesign,
		growthFacility: s.growthFacility,
		lastUpdate: s.lastUpdate,
		trialDbId: s.trialId,
		trialName,
		locationDbId: s.locationId,
		locationName,
		seasons: seasonsByStudy.get(s.id) ?? [],
		contacts: contactsByStudy.get(s.id) ?? [],
		dataLinks: [],
		environmentParameters: [],
		externalReferences: s.externalReferences ?? [],
		additionalInfo: s.additionalInfo ?? {}
	}));

	return brapiJson(brapiListResponse(data, page, pageSize, totalCount));
};
