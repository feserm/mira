import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	observationUnit,
	germplasm,
	location,
	program,
	study,
	trial,
	seedLot,
	cross,
	studySeason
} from '$lib/server/db/schema';
import { resolveArcId } from '$lib/server/brapi/arc';
import type { BrapiObservationUnit } from '$lib/types/brapi/phenotyping';
import {
	brapiJson,
	brapiListResponse,
	parseBrapiPagination,
	hasMalformedDbId
} from '$lib/server/brapi/response';
import { authenticateBrapi } from '$lib/server/brapi/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	await authenticateBrapi(event);

	const arcId = await resolveArcId(event.params.repo);

	const params = event.url.searchParams;
	const { page, pageSize } = parseBrapiPagination(params);
	if (hasMalformedDbId(params)) return brapiJson(brapiListResponse([], page, pageSize, 0));

	const commonCropName = params.get('commonCropName');
	const germplasmDbId = params.get('germplasmDbId');
	const locationDbId = params.get('locationDbId');
	const studyDbId = params.get('studyDbId');
	const programDbId = params.get('programDbId');
	const trialDbId = params.get('trialDbId');
	const observationUnitDbId = params.get('observationUnitDbId');
	const observationUnitName = params.get('observationUnitName');
	const observationUnitLevelName = params.get('observationUnitLevelName');
	const observationUnitLevelOrder = params.get('observationUnitLevelOrder');
	const observationUnitLevelCode = params.get('observationUnitLevelCode');
	const levelRelationshipName = params.get('observationUnitLevelRelationshipName');
	const levelRelationshipOrder = params.get('observationUnitLevelRelationshipOrder');
	const levelRelationshipCode = params.get('observationUnitLevelRelationshipCode');
	const levelRelationshipDbId = params.get('observationUnitLevelRelationshipDbId');
	const seasonDbId = params.get('seasonDbId');
	const externalReferenceId = params.get('externalReferenceId');
	const externalReferenceSource = params.get('externalReferenceSource');

	const externalReferenceFilter: Record<string, string> = {};
	if (externalReferenceId) externalReferenceFilter.referenceId = externalReferenceId;
	if (externalReferenceSource) externalReferenceFilter.referenceSource = externalReferenceSource;

	// `observationLevelRelationships` is an array of ancestor levels on
	// `observationUnitPosition`, so matching it needs an EXISTS over its elements rather than a
	// single jsonb path lookup (used for `observationLevel`, which isn't an array). Only built
	// when at least one of the four related params is present.
	const levelRelationshipFilter =
		levelRelationshipName ||
		levelRelationshipOrder ||
		levelRelationshipCode ||
		levelRelationshipDbId
			? sql`exists (
					select 1
					from jsonb_array_elements(
						coalesce(${observationUnit.observationUnitPosition}->'observationLevelRelationships', '[]'::jsonb)
					) as rel
					where (${levelRelationshipName}::text is null or rel->>'levelName' = ${levelRelationshipName})
						and (${levelRelationshipOrder}::text is null or rel->>'levelOrder' = ${levelRelationshipOrder})
						and (${levelRelationshipCode}::text is null or rel->>'levelCode' = ${levelRelationshipCode})
						and (${levelRelationshipDbId}::text is null or rel->>'observationUnitDbId' = ${levelRelationshipDbId})
				)`
			: undefined;

	const where = and(
		eq(observationUnit.arcId, arcId),
		commonCropName ? eq(study.commonCropName, commonCropName) : undefined,
		germplasmDbId ? eq(observationUnit.germplasmId, germplasmDbId) : undefined,
		locationDbId ? eq(observationUnit.locationId, locationDbId) : undefined,
		studyDbId ? eq(observationUnit.studyId, studyDbId) : undefined,
		programDbId ? eq(observationUnit.programId, programDbId) : undefined,
		trialDbId ? eq(observationUnit.trialId, trialDbId) : undefined,
		observationUnitDbId ? eq(observationUnit.id, observationUnitDbId) : undefined,
		observationUnitName ? eq(observationUnit.observationUnitName, observationUnitName) : undefined,
		observationUnitLevelName
			? sql`${observationUnit.observationUnitPosition}->'observationLevel'->>'levelName' = ${observationUnitLevelName}`
			: undefined,
		observationUnitLevelOrder
			? sql`${observationUnit.observationUnitPosition}->'observationLevel'->>'levelOrder' = ${observationUnitLevelOrder}`
			: undefined,
		observationUnitLevelCode
			? sql`${observationUnit.observationUnitPosition}->'observationLevel'->>'levelCode' = ${observationUnitLevelCode}`
			: undefined,
		levelRelationshipFilter,
		seasonDbId
			? inArray(
					observationUnit.studyId,
					db
						.select({ studyId: studySeason.studyId })
						.from(studySeason)
						.where(eq(studySeason.seasonId, seasonDbId))
				)
			: undefined,
		Object.keys(externalReferenceFilter).length
			? sql`${observationUnit.externalReferences} @> ${JSON.stringify([externalReferenceFilter])}::jsonb`
			: undefined
	);

	const [rows, [{ totalCount }]] = await Promise.all([
		db
			.select({
				observationUnit,
				germplasmName: germplasm.germplasmName,
				locationName: location.name,
				programName: program.name,
				studyName: study.name,
				trialName: trial.name,
				seedLotName: seedLot.seedLotName,
				crossName: cross.crossName
			})
			.from(observationUnit)
			.leftJoin(germplasm, eq(observationUnit.germplasmId, germplasm.id))
			.leftJoin(location, eq(observationUnit.locationId, location.id))
			.leftJoin(program, eq(observationUnit.programId, program.id))
			.leftJoin(study, eq(observationUnit.studyId, study.id))
			.leftJoin(trial, eq(observationUnit.trialId, trial.id))
			.leftJoin(seedLot, eq(observationUnit.seedLotId, seedLot.id))
			.leftJoin(cross, eq(observationUnit.crossId, cross.id))
			.where(where)
			.orderBy(asc(observationUnit.id))
			.limit(pageSize)
			.offset(page * pageSize),
		db
			.select({ totalCount: count() })
			.from(observationUnit)
			.leftJoin(study, eq(observationUnit.studyId, study.id))
			.where(where)
	]);

	const data: BrapiObservationUnit[] = rows.map((row) => ({
		observationUnitDbId: row.observationUnit.id,
		observationUnitName: row.observationUnit.observationUnitName,
		observationUnitPUI: row.observationUnit.observationUnitPui,
		crossDbId: row.observationUnit.crossId,
		crossName: row.crossName,
		germplasmDbId: row.observationUnit.germplasmId,
		germplasmName: row.germplasmName,
		locationDbId: row.observationUnit.locationId,
		locationName: row.locationName,
		observationUnitPosition: row.observationUnit.observationUnitPosition,
		programDbId: row.observationUnit.programId,
		programName: row.programName,
		seedLotDbId: row.observationUnit.seedLotId,
		seedLotName: row.seedLotName,
		studyDbId: row.observationUnit.studyId,
		studyName: row.studyName,
		treatments: row.observationUnit.treatments ?? [],
		trialDbId: row.observationUnit.trialId,
		trialName: row.trialName,
		externalReferences: row.observationUnit.externalReferences ?? [],
		additionalInfo: row.observationUnit.additionalInfo ?? {}
	}));

	return brapiJson(brapiListResponse(data, page, pageSize, totalCount));
};
