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
	accessionNames?: string[];
	accessionNumber?: string;
	acquisitionDate?: string;
	acquisitionSourceCode?: string;
	alternateIDs?: string[];
	ancestralData?: string;
	biologicalStatusOfAccessionCode?: string;
	breedingInstitutes?: Institute[];
	collectingInfo?: CollectingInfo;
	commonCropName?: string;
	countryOfOrigin?: string;
	donorInfo?: DonorInfo;
	genus?: string;
	germplasmDbId?: string;
	germplasmPUI?: string;
	instituteCode?: string;
	mlsStatus?: string;
	remarks?: string;
	safetyDuplicateInstitutes?: Institute[];
	species?: string;
	speciesAuthority?: string;
	storageTypeCodes?: StorageTypeCode[];
	subtaxon?: string;
	subtaxonAuthority?: string;
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
