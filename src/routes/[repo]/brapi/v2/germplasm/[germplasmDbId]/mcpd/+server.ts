import { error } from '@sveltejs/kit';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { germplasm, observationUnit } from '$lib/server/db/schema';
import { resolveReadableArc } from '$lib/server/brapi/arc';
import type { GermplasmMcpd, StorageTypeCode } from '$lib/types/brapi/germplasm';
import { brapiJson, brapiSingleResponse, isDbId } from '$lib/server/brapi/response';
import { authenticateBrapi } from '$lib/server/brapi/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	await authenticateBrapi(event);

	const arcId = await resolveReadableArc(event);
	const { germplasmDbId } = event.params;
	if (!isDbId(germplasmDbId)) error(404, `Unknown germplasmDbId: "${germplasmDbId}"`);

	// `germplasm` isn't arc-scoped (see the germplasm list endpoint), so membership in this ARC
	// is defined by being referenced from one of the ARC's observation units.
	const [row] = await db
		.select({ germplasm })
		.from(germplasm)
		.where(
			and(
				eq(germplasm.id, germplasmDbId),
				inArray(
					germplasm.id,
					db
						.select({ germplasmId: observationUnit.germplasmId })
						.from(observationUnit)
						.where(and(eq(observationUnit.arcId, arcId), isNotNull(observationUnit.germplasmId)))
				)
			)
		);

	if (!row) error(404, `Unknown germplasmDbId: "${germplasmDbId}"`);

	const g = row.germplasm;
	const mcpd = g.mcpd ?? {};

	const storageTypeCodes = g.storageTypes
		?.map((s) => s.code)
		.filter((code): code is StorageTypeCode => code !== undefined);

	const data: GermplasmMcpd = {
		accessionNames: mcpd.accessionNames ?? null,
		accessionNumber: g.accessionNumber ?? null,
		acquisitionDate: g.acquisitionDate ?? null,
		acquisitionSourceCode: mcpd.acquisitionSourceCode ?? null,
		alternateIDs: mcpd.alternateIDs ?? null,
		ancestralData: mcpd.ancestralData ?? null,
		biologicalStatusOfAccessionCode: g.biologicalStatusOfAccessionCode ?? null,
		breedingInstitutes: mcpd.breedingInstitutes ?? null,
		collectingInfo: mcpd.collectingInfo ?? null,
		commonCropName: g.commonCropName ?? null,
		countryOfOrigin: g.countryOfOriginCode ?? null,
		donorInfo: mcpd.donorInfo ?? null,
		genus: g.genus ?? null,
		germplasmDbId: g.id ?? null,
		germplasmPUI: g.germplasmPui ?? null,
		instituteCode: g.instituteCode ?? null,
		mlsStatus: mcpd.mlsStatus ?? null,
		remarks: mcpd.remarks ?? null,
		safetyDuplicateInstitutes: mcpd.safetyDuplicateInstitutes ?? null,
		species: g.species ?? null,
		speciesAuthority: g.speciesAuthority ?? null,
		storageTypeCodes: storageTypeCodes && storageTypeCodes.length > 0 ? storageTypeCodes : null,
		subtaxon: g.subtaxa ?? null,
		subtaxonAuthority: g.subtaxaAuthority ?? null
	};

	return brapiJson(brapiSingleResponse(data));
};
