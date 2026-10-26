import { and, asc, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '$lib/server/db';
import { location, study, trial } from '$lib/server/db/schema';
import { resolveArcId } from '$lib/server/brapi/arc';
import type { BrapiLocation } from '$lib/types/brapi/core';
import {
	brapiJson,
	brapiListResponse,
	parseBrapiPagination,
	hasMalformedDbId
} from '$lib/server/brapi/response';
import { authenticateBrapi } from '$lib/server/brapi/auth';
import type { RequestHandler } from './$types';

const parentLocation = alias(location, 'parent_location');

export const GET: RequestHandler = async (event) => {
	await authenticateBrapi(event);

	const arcId = await resolveArcId(event.params.repo);

	const params = event.url.searchParams;
	const { page, pageSize } = parseBrapiPagination(params);
	if (hasMalformedDbId(params)) return brapiJson(brapiListResponse([], page, pageSize, 0));

	const commonCropName = params.get('commonCropName');
	const locationDbId = params.get('locationDbId');
	const locationName = params.get('locationName');
	const programDbId = params.get('programDbId');
	const locationType = params.get('locationType');
	const parentLocationDbId = params.get('parentLocationDbId');
	const parentLocationName = params.get('parentLocationName');
	const externalReferenceId = params.get('externalReferenceId');
	const externalReferenceSource = params.get('externalReferenceSource');

	// `location` isn't arc-scoped (it's a globally-deduped reference table - see
	// upsertLocation in load.ts), so membership in this ARC is defined by being referenced
	// from one of the ARC's studies. commonCropName/programDbId live on study/trial rather
	// than location, so they narrow this same subquery instead of a separate join.
	const arcLocationIds = db
		.select({ locationId: study.locationId })
		.from(study)
		.leftJoin(trial, eq(study.trialId, trial.id))
		.where(
			and(
				eq(study.arcId, arcId),
				isNotNull(study.locationId),
				commonCropName ? eq(study.commonCropName, commonCropName) : undefined,
				programDbId ? eq(trial.programId, programDbId) : undefined
			)
		);

	const externalReferenceFilter: Record<string, string> = {};
	if (externalReferenceId) externalReferenceFilter.referenceId = externalReferenceId;
	if (externalReferenceSource) externalReferenceFilter.referenceSource = externalReferenceSource;

	const where = and(
		inArray(location.id, arcLocationIds),
		locationDbId ? eq(location.id, locationDbId) : undefined,
		locationName ? eq(location.name, locationName) : undefined,
		locationType ? eq(location.locationType, locationType) : undefined,
		parentLocationDbId ? eq(location.parentLocationId, parentLocationDbId) : undefined,
		parentLocationName
			? inArray(
					location.parentLocationId,
					db.select({ id: location.id }).from(location).where(eq(location.name, parentLocationName))
				)
			: undefined,
		Object.keys(externalReferenceFilter).length
			? sql`${location.externalReferences} @> ${JSON.stringify([externalReferenceFilter])}::jsonb`
			: undefined
	);

	const [rows, [{ totalCount }]] = await Promise.all([
		db
			.select({ location, parentLocationName: parentLocation.name })
			.from(location)
			.leftJoin(parentLocation, eq(location.parentLocationId, parentLocation.id))
			.where(where)
			.orderBy(asc(location.id))
			.limit(pageSize)
			.offset(page * pageSize),
		db.select({ totalCount: count() }).from(location).where(where)
	]);

	const data: BrapiLocation[] = rows.map(({ location: l, parentLocationName: parentName }) => ({
		locationDbId: l.id,
		locationName: l.name,
		abbreviation: l.abbreviation,
		coordinateDescription: l.coordinateDescription,
		coordinateUncertainty: l.coordinateUncertainty,
		coordinates: l.coordinates,
		countryCode: l.countryCode,
		countryName: l.countryName,
		documentationURL: l.documentationUrl,
		environmentType: l.environmentType,
		exposure: l.exposure,
		externalReferences: l.externalReferences ?? [],
		instituteAddress: l.instituteAddress,
		instituteName: l.instituteName,
		locationType: l.locationType,
		parentLocationDbId: l.parentLocationId,
		parentLocationName: parentName,
		siteStatus: l.siteStatus,
		slope: l.slope,
		topography: l.topography,
		additionalInfo: l.additionalInfo ?? {}
	}));

	return brapiJson(brapiListResponse(data, page, pageSize, totalCount));
};
