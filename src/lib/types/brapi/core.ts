import type {
	person,
	contact,
	season,
	location,
	program,
	trial,
	trialContact,
	study,
	studyContact,
	studySeason,
	list
} from '$lib/server/db/schema/brapi/core';
import type { ExternalReference, AdditionalInfo, GeoJSON } from '$lib/types/brapi/common';
import type {
	Donor,
	StorageType,
	GermplasmSynonym,
	TaxonId,
	GermplasmOrigin
} from '$lib/types/brapi/germplasm';

export interface Publication {
	publicationPUI?: string;
	publicationReference?: string;
}

export interface DatasetAuthorship {
	datasetPUI?: string;
	license?: string;
	submissionDate?: string;
	publicReleaseDate?: string;
}

export interface ObservationLevel {
	levelName?: string;
	levelOrder?: number;
}

export interface ExperimentalDesign {
	PUI?: string;
	description?: string;
}

export interface GrowthFacility {
	PUI?: string;
	description?: string;
}

export interface StudyLastUpdate {
	timestamp?: string;
	version?: string;
}

export type Person = typeof person.$inferSelect;
export type NewPerson = typeof person.$inferInsert;

export type Contact = typeof contact.$inferSelect;
export type NewContact = typeof contact.$inferInsert;

export type Season = typeof season.$inferSelect;
export type NewSeason = typeof season.$inferInsert;

export type Location = typeof location.$inferSelect;
export type NewLocation = typeof location.$inferInsert;

export type Program = typeof program.$inferSelect;
export type NewProgram = typeof program.$inferInsert;

export type Trial = typeof trial.$inferSelect;
export type NewTrial = typeof trial.$inferInsert;

export type TrialContact = typeof trialContact.$inferSelect;
export type NewTrialContact = typeof trialContact.$inferInsert;

export type Study = typeof study.$inferSelect;
export type NewStudy = typeof study.$inferInsert;

export type StudyContact = typeof studyContact.$inferSelect;
export type NewStudyContact = typeof studyContact.$inferInsert;

export type StudySeason = typeof studySeason.$inferSelect;
export type NewStudySeason = typeof studySeason.$inferInsert;

export type List = typeof list.$inferSelect;
export type NewList = typeof list.$inferInsert;

/** BrAPI wire-format Contact, as embedded in Trial/Study responses. */
export interface BrapiContact {
	contactDbId: string;
	name?: string | null;
	email?: string | null;
	instituteName?: string | null;
	orcid?: string | null;
	type?: string | null;
}

/** BrAPI wire-format Trial, as returned by GET /trials. */
export interface BrapiTrial {
	trialDbId: string;
	trialName: string;
	trialDescription?: string | null;
	trialPUI?: string | null;
	active?: boolean | null;
	commonCropName?: string | null;
	documentationURL?: string | null;
	startDate?: string | null;
	endDate?: string | null;
	programDbId?: string | null;
	programName?: string | null;
	contacts: BrapiContact[];
	publications: Publication[];
	datasetAuthorships: DatasetAuthorship[];
	externalReferences: ExternalReference[];
	additionalInfo: AdditionalInfo;
}

/**
 * BrAPI wire-format Study, as returned by GET /studies. `dataLinks` and
 * `environmentParameters` have no backing column/table yet, so they're always `[]`.
 */
export interface BrapiStudy {
	studyDbId: string;
	studyName?: string | null;
	studyDescription?: string | null;
	studyCode?: string | null;
	studyPUI?: string | null;
	studyType?: string | null;
	commonCropName?: string | null;
	active?: boolean | null;
	startDate?: string | null;
	endDate?: string | null;
	culturalPractices?: string | null;
	documentationURL?: string | null;
	license?: string | null;
	observationUnitsDescription?: string | null;
	observationLevels: ObservationLevel[];
	observationVariableDbIds: string[];
	experimentalDesign?: ExperimentalDesign | null;
	growthFacility?: GrowthFacility | null;
	lastUpdate?: StudyLastUpdate | null;
	trialDbId?: string | null;
	trialName?: string | null;
	locationDbId?: string | null;
	locationName?: string | null;
	seasons: string[];
	contacts: BrapiContact[];
	dataLinks: unknown[];
	environmentParameters: unknown[];
	externalReferences: ExternalReference[];
	additionalInfo: AdditionalInfo;
}

/** BrAPI wire-format Location, as returned by GET /locations. */
export interface BrapiLocation {
	locationDbId: string;
	locationName: string;
	abbreviation?: string | null;
	coordinateDescription?: string | null;
	coordinateUncertainty?: string | null;
	coordinates?: GeoJSON | null;
	countryCode?: string | null;
	countryName?: string | null;
	documentationURL?: string | null;
	environmentType?: string | null;
	exposure?: string | null;
	externalReferences: ExternalReference[];
	instituteAddress?: string | null;
	instituteName?: string | null;
	locationType?: string | null;
	parentLocationDbId?: string | null;
	parentLocationName?: string | null;
	siteStatus?: string | null;
	slope?: string | null;
	topography?: string | null;
	additionalInfo: AdditionalInfo;
}

/** BrAPI wire-format Germplasm, as returned by GET /germplasm. */
export interface BrapiGermplasm {
	germplasmDbId: string;
	germplasmName: string;
	germplasmPUI: string;
	commonCropName: string;
	accessionNumber?: string | null;
	acquisitionDate?: string | null;
	biologicalStatusOfAccessionCode?: string | null;
	biologicalStatusOfAccessionDescription?: string | null;
	breedingMethodDbId?: string | null;
	breedingMethodName?: string | null;
	collection?: string | null;
	countryOfOriginCode?: string | null;
	defaultDisplayName?: string | null;
	documentationURL?: string | null;
	donors: Donor[];
	genus?: string | null;
	germplasmOrigin: GermplasmOrigin[];
	germplasmPreprocessing?: string | null;
	instituteCode?: string | null;
	instituteName?: string | null;
	pedigree?: string | null;
	seedSource?: string | null;
	seedSourceDescription?: string | null;
	species?: string | null;
	speciesAuthority?: string | null;
	storageTypes: StorageType[];
	subtaxa?: string | null;
	subtaxaAuthority?: string | null;
	synonyms: GermplasmSynonym[];
	taxonIds: TaxonId[];
	externalReferences: ExternalReference[];
	additionalInfo: AdditionalInfo;
}

/** BrAPI wire-format Service, describing one implemented call, as embedded in ServerInfo. */
export interface BrapiService {
	service: string;
	methods: ('GET' | 'POST' | 'PUT' | 'DELETE')[];
	versions: string[];
	contentTypes: string[];
}

/** BrAPI wire-format ServerInfo, as returned by GET /serverinfo. */
export interface BrapiServerInfo {
	serverName?: string;
	serverDescription?: string;
	documentationURL?: string;
	calls: BrapiService[];
}
