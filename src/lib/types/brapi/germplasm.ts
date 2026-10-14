import type {
	breedingMethod,
	germplasm,
	crossingProject,
	crossingProjectPotentialParent,
	cross,
	plannedCross,
	pedigreeNode,
	pedigreeNodeParent,
	seedLot,
	seedLotContent,
	seedLotTransaction,
	germplasmAttribute,
	germplasmAttributeValue
} from '$lib/server/db/schema/brapi/germplasm';
import type { GeoJSON, Institute } from './common';

export interface Donor {
	donorAccessionNumber?: string;
	donorInstituteCode?: string;
}

export type StorageTypeCode = '10' | '11' | '12' | '13' | '20' | '30' | '40' | '50' | '99';

export interface StorageType {
	code?: StorageTypeCode;
	description?: string;
}

export interface GermplasmSynonym {
	synonym?: string;
	type?: string;
}

export interface TaxonId {
	sourceName: string;
	taxonId: string;
}

export interface GermplasmOrigin {
	coordinates?: GeoJSON;
	coordinateUncertainty?: string;
}

export interface CollectingSite {
	coordinateUncertainty?: string;
	elevation?: string;
	georeferencingMethod?: string;
	latitudeDecimal?: string;
	latitudeDegrees?: string;
	locationDescription?: string;
	longitudeDecimal?: string;
	longitudeDegrees?: string;
	spatialReferenceSystem?: string;
}

export interface CollectingInfo {
	collectingDate?: string;
	collectingInstitutes?: Institute[];
	collectingMissionIdentifier?: string;
	collectingNumber?: string;
	collectingSite?: CollectingSite;
}

export interface DonorInfo {
	donorAccessionPui?: string;
	donorAccessionNumber?: string;
	donorInstitute?: Institute;
}

/** MCPD (Multi-Crop Passport Descriptors) block, BrAPI `GermplasmMCPD`. */
export interface GermplasmMcpd {
	accessionNames?: string[] | null;
	accessionNumber?: string | null;
	acquisitionDate?: string | null;
	acquisitionSourceCode?: string | null;
	alternateIDs?: string[] | null;
	ancestralData?: string | null;
	biologicalStatusOfAccessionCode?: string | null;
	breedingInstitutes?: Institute[] | null;
	collectingInfo?: CollectingInfo | null;
	commonCropName?: string | null;
	countryOfOrigin?: string | null;
	donorInfo?: DonorInfo | null;
	genus?: string | null;
	germplasmDbId?: string | null;
	germplasmPUI?: string | null;
	instituteCode?: string | null;
	mlsStatus?: string | null;
	remarks?: string | null;
	safetyDuplicateInstitutes?: Institute[] | null;
	species?: string | null;
	speciesAuthority?: string | null;
	storageTypeCodes?: StorageTypeCode[] | null;
	subtaxon?: string | null;
	subtaxonAuthority?: string | null;
}

export interface CrossAttribute {
	crossAttributeName?: string;
	crossAttributeValue?: string;
}

export interface PollinationEvent {
	pollinationTimeStamp?: string;
	pollinationSuccessful?: boolean;
	pollinationNumber?: string;
}

export type BreedingMethod = typeof breedingMethod.$inferSelect;
export type NewBreedingMethod = typeof breedingMethod.$inferInsert;

export type Germplasm = typeof germplasm.$inferSelect;
export type NewGermplasm = typeof germplasm.$inferInsert;

export type CrossingProject = typeof crossingProject.$inferSelect;
export type NewCrossingProject = typeof crossingProject.$inferInsert;

export type CrossingProjectPotentialParent = typeof crossingProjectPotentialParent.$inferSelect;
export type NewCrossingProjectPotentialParent = typeof crossingProjectPotentialParent.$inferInsert;

export type Cross = typeof cross.$inferSelect;
export type NewCross = typeof cross.$inferInsert;

export type PlannedCross = typeof plannedCross.$inferSelect;
export type NewPlannedCross = typeof plannedCross.$inferInsert;

export type PedigreeNode = typeof pedigreeNode.$inferSelect;
export type NewPedigreeNode = typeof pedigreeNode.$inferInsert;

export type PedigreeNodeParent = typeof pedigreeNodeParent.$inferSelect;
export type NewPedigreeNodeParent = typeof pedigreeNodeParent.$inferInsert;

export type SeedLot = typeof seedLot.$inferSelect;
export type NewSeedLot = typeof seedLot.$inferInsert;

export type SeedLotContent = typeof seedLotContent.$inferSelect;
export type NewSeedLotContent = typeof seedLotContent.$inferInsert;

export type SeedLotTransaction = typeof seedLotTransaction.$inferSelect;
export type NewSeedLotTransaction = typeof seedLotTransaction.$inferInsert;

export type GermplasmAttribute = typeof germplasmAttribute.$inferSelect;
export type NewGermplasmAttribute = typeof germplasmAttribute.$inferInsert;

export type GermplasmAttributeValue = typeof germplasmAttributeValue.$inferSelect;
export type NewGermplasmAttributeValue = typeof germplasmAttributeValue.$inferInsert;
