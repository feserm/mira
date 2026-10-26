import { and, asc, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	germplasm,
	breedingMethod,
	pedigreeNode,
	pedigreeNodeParent,
	observationUnit
} from '$lib/server/db/schema';
import { resolveReadableArc } from '$lib/server/brapi/arc';
import type { BrapiGermplasm } from '$lib/types/brapi/core';
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

	const arcId = await resolveReadableArc(event);

	const params = event.url.searchParams;
	const { page, pageSize } = parseBrapiPagination(params);
	if (hasMalformedDbId(params)) return brapiJson(brapiListResponse([], page, pageSize, 0));

	const commonCropName = params.get('commonCropName');
	const germplasmDbId = params.get('germplasmDbId');
	const germplasmName = params.get('germplasmName');
	const programDbId = params.get('programDbId');
	const studyDbId = params.get('studyDbId');
	const trialDbId = params.get('trialDbId');
	const germplasmPUI = params.get('germplasmPUI');
	const accessionNumber = params.get('accessionNumber');
	const collection = params.get('collection');
	const binomialName = params.get('binomialName');
	const genus = params.get('genus');
	const species = params.get('species');
	const synonym = params.get('synonym');
	const parentDbId = params.get('parentDbId');
	const progenyDbId = params.get('progenyDbId');
	const externalReferenceId = params.get('externalReferenceId');
	const externalReferenceSource = params.get('externalReferenceSource');

	const externalReferenceFilter: Record<string, string> = {};
	if (externalReferenceId) externalReferenceFilter.referenceId = externalReferenceId;
	if (externalReferenceSource) externalReferenceFilter.referenceSource = externalReferenceSource;

	// `germplasm` isn't arc-scoped (it's a globally-deduped reference table, like `location` -
	// see the locations endpoint), so membership in this ARC is defined by being referenced from
	// one of the ARC's observation units. programDbId/studyDbId/trialDbId are also observation-
	// unit-level associations, so they narrow this same subquery instead of a separate join.
	const arcGermplasmIds = db
		.select({ germplasmId: observationUnit.germplasmId })
		.from(observationUnit)
		.where(
			and(
				eq(observationUnit.arcId, arcId),
				isNotNull(observationUnit.germplasmId),
				programDbId ? eq(observationUnit.programId, programDbId) : undefined,
				studyDbId ? eq(observationUnit.studyId, studyDbId) : undefined,
				trialDbId ? eq(observationUnit.trialId, trialDbId) : undefined
			)
		);

	const where = and(
		inArray(germplasm.id, arcGermplasmIds),
		commonCropName ? eq(germplasm.commonCropName, commonCropName) : undefined,
		germplasmDbId ? eq(germplasm.id, germplasmDbId) : undefined,
		germplasmName ? eq(germplasm.germplasmName, germplasmName) : undefined,
		germplasmPUI ? eq(germplasm.germplasmPui, germplasmPUI) : undefined,
		accessionNumber ? eq(germplasm.accessionNumber, accessionNumber) : undefined,
		collection ? eq(germplasm.collection, collection) : undefined,
		genus ? eq(germplasm.genus, genus) : undefined,
		species ? eq(germplasm.species, species) : undefined,
		binomialName
			? sql`${germplasm.genus} || ' ' || ${germplasm.species} = ${binomialName}`
			: undefined,
		synonym ? sql`${germplasm.synonyms} @> ${JSON.stringify([{ synonym }])}::jsonb` : undefined,
		parentDbId
			? inArray(
					germplasm.id,
					db
						.select({ germplasmId: pedigreeNode.germplasmId })
						.from(pedigreeNode)
						.innerJoin(pedigreeNodeParent, eq(pedigreeNodeParent.pedigreeNodeId, pedigreeNode.id))
						.where(eq(pedigreeNodeParent.germplasmId, parentDbId))
				)
			: undefined,
		progenyDbId
			? inArray(
					germplasm.id,
					db
						.select({ germplasmId: pedigreeNodeParent.germplasmId })
						.from(pedigreeNodeParent)
						.innerJoin(pedigreeNode, eq(pedigreeNode.id, pedigreeNodeParent.pedigreeNodeId))
						.where(eq(pedigreeNode.germplasmId, progenyDbId))
				)
			: undefined,
		Object.keys(externalReferenceFilter).length
			? sql`${germplasm.externalReferences} @> ${JSON.stringify([externalReferenceFilter])}::jsonb`
			: undefined
	);

	const [rows, [{ totalCount }]] = await Promise.all([
		db
			.select({ germplasm, breedingMethodName: breedingMethod.breedingMethodName })
			.from(germplasm)
			.leftJoin(breedingMethod, eq(germplasm.breedingMethodId, breedingMethod.id))
			.where(where)
			.orderBy(asc(germplasm.id))
			.limit(pageSize)
			.offset(page * pageSize),
		db.select({ totalCount: count() }).from(germplasm).where(where)
	]);

	const data: BrapiGermplasm[] = rows.map(({ germplasm: g, breedingMethodName }) => ({
		germplasmDbId: g.id,
		germplasmName: g.germplasmName,
		germplasmPUI: g.germplasmPui,
		commonCropName: g.commonCropName,
		accessionNumber: g.accessionNumber,
		acquisitionDate: g.acquisitionDate,
		biologicalStatusOfAccessionCode: g.biologicalStatusOfAccessionCode,
		biologicalStatusOfAccessionDescription: g.biologicalStatusOfAccessionDescription,
		breedingMethodDbId: g.breedingMethodId,
		breedingMethodName,
		collection: g.collection,
		countryOfOriginCode: g.countryOfOriginCode,
		defaultDisplayName: g.defaultDisplayName,
		documentationURL: g.documentationUrl,
		donors: g.donors ?? [],
		genus: g.genus,
		germplasmOrigin: g.germplasmOrigin ?? [],
		germplasmPreprocessing: g.germplasmPreprocessing,
		instituteCode: g.instituteCode,
		instituteName: g.instituteName,
		pedigree: g.pedigree,
		seedSource: g.seedSource,
		seedSourceDescription: g.seedSourceDescription,
		species: g.species,
		speciesAuthority: g.speciesAuthority,
		storageTypes: g.storageTypes ?? [],
		subtaxa: g.subtaxa,
		subtaxaAuthority: g.subtaxaAuthority,
		synonyms: g.synonyms ?? [],
		taxonIds: g.taxonIds ?? [],
		externalReferences: g.externalReferences ?? [],
		additionalInfo: g.additionalInfo ?? {}
	}));

	return brapiJson(brapiListResponse(data, page, pageSize, totalCount));
};
