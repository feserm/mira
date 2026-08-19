import {
	pgTable,
	pgEnum,
	uuid,
	text,
	integer,
	numeric,
	timestamp,
	date,
	jsonb,
	unique,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { roCrateStaging } from '../staging/schema';
import type { ExternalReference, AdditionalInfo, OntologyReference } from '$lib/types/brapi/common';
import type {
	Donor,
	StorageType,
	GermplasmSynonym,
	TaxonId,
	GermplasmOrigin,
	GermplasmMcpd,
	CrossAttribute,
	PollinationEvent
} from '$lib/types/brapi/germplasm';
import { location, program } from './core';
import { observationUnit, trait, method, scale, ontology } from './phenotyping';

export const crossType = pgEnum('cross_type', [
	'BIPARENTAL',
	'SELF',
	'OPEN_POLLINATED',
	'BULK',
	'BULK_SELFED',
	'BULK_OPEN_POLLINATED',
	'DOUBLE_HAPLOID'
]);

export const parentType = pgEnum('parent_type', ['MALE', 'FEMALE', 'SELF', 'POPULATION', 'CLONAL']);

export const plannedCrossStatus = pgEnum('planned_cross_status', ['TODO', 'DONE', 'SKIPPED']);

export const breedingMethod = pgTable('breeding_method', {
	id: uuid('id').primaryKey().defaultRandom(),
	abbreviation: text('abbreviation'),
	breedingMethodName: text('breeding_method_name').unique(),
	description: text('description'),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

export const germplasm = pgTable('germplasm', {
	id: uuid('id').primaryKey().defaultRandom(),
	germplasmName: text('germplasm_name').notNull(),
	germplasmPui: text('germplasm_pui').notNull().unique(),
	defaultDisplayName: text('default_display_name'),
	accessionNumber: text('accession_number'),
	acquisitionDate: date('acquisition_date'),
	biologicalStatusOfAccessionCode: text('biological_status_of_accession_code'),
	biologicalStatusOfAccessionDescription: text('biological_status_of_accession_description'),
	breedingMethodId: uuid('breeding_method_id').references(() => breedingMethod.id),
	collection: text('collection'),
	commonCropName: text('common_crop_name').notNull(),
	countryOfOriginCode: text('country_of_origin_code'),
	documentationUrl: text('documentation_url'),
	genus: text('genus'),
	germplasmPreprocessing: text('germplasm_preprocessing'),
	instituteCode: text('institute_code'),
	instituteName: text('institute_name'),
	pedigree: text('pedigree'),
	seedSource: text('seed_source'),
	seedSourceDescription: text('seed_source_description'),
	species: text('species'),
	speciesAuthority: text('species_authority'),
	subtaxa: text('subtaxa'),
	subtaxaAuthority: text('subtaxa_authority'),
	donors: jsonb('donors').$type<Donor[]>(),
	storageTypes: jsonb('storage_types').$type<StorageType[]>(),
	synonyms: jsonb('synonyms').$type<GermplasmSynonym[]>(),
	taxonIds: jsonb('taxon_ids').$type<TaxonId[]>(),
	germplasmOrigin: jsonb('germplasm_origin').$type<GermplasmOrigin[]>(),
	mcpd: jsonb('mcpd').$type<GermplasmMcpd>(),
	externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
	additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

export const crossingProject = pgTable(
	'crossing_project',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		programId: uuid('program_id').references(() => program.id),
		crossingProjectName: text('crossing_project_name').notNull(),
		crossingProjectDescription: text('crossing_project_description'),
		commonCropName: text('common_crop_name'),
		externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
		additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
		arcId: integer('arc_id')
			.notNull()
			.references(() => roCrateStaging.arcId, { onDelete: 'cascade' }),
		sourceId: text('source_id'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.arcId, table.sourceId)]
);

export const crossingProjectPotentialParent = pgTable(
	'crossing_project_potential_parent',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		crossingProjectId: uuid('crossing_project_id')
			.notNull()
			.references(() => crossingProject.id, { onDelete: 'cascade' }),
		germplasmId: uuid('germplasm_id').references(() => germplasm.id),
		observationUnitId: uuid('observation_unit_id').references(() => observationUnit.id),
		parentType: parentType('parent_type'),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [unique().on(table.crossingProjectId, table.germplasmId, table.observationUnitId)]
);

export const cross = pgTable(
	'cross',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		crossingProjectId: uuid('crossing_project_id').references(() => crossingProject.id),
		crossName: text('cross_name'),
		crossType: crossType('cross_type'),
		parent1GermplasmId: uuid('parent1_germplasm_id').references(() => germplasm.id),
		parent1ObservationUnitId: uuid('parent1_observation_unit_id').references(
			(): AnyPgColumn => observationUnit.id
		),
		parent1Type: parentType('parent1_type'),
		parent2GermplasmId: uuid('parent2_germplasm_id').references(() => germplasm.id),
		parent2ObservationUnitId: uuid('parent2_observation_unit_id').references(
			(): AnyPgColumn => observationUnit.id
		),
		parent2Type: parentType('parent2_type'),
		pollinationTimestamp: timestamp('pollination_timestamp'),
		crossAttributes: jsonb('cross_attributes').$type<CrossAttribute[]>(),
		pollinationEvents: jsonb('pollination_events').$type<PollinationEvent[]>(),
		externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
		additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
		arcId: integer('arc_id')
			.notNull()
			.references(() => roCrateStaging.arcId, { onDelete: 'cascade' }),
		sourceId: text('source_id'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.arcId, table.sourceId)]
);

export const plannedCross = pgTable(
	'planned_cross',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		crossingProjectId: uuid('crossing_project_id').references(() => crossingProject.id),
		plannedCrossName: text('planned_cross_name'),
		crossType: crossType('cross_type'),
		status: plannedCrossStatus('status'),
		parent1GermplasmId: uuid('parent1_germplasm_id').references(() => germplasm.id),
		parent1ObservationUnitId: uuid('parent1_observation_unit_id').references(
			() => observationUnit.id
		),
		parent1Type: parentType('parent1_type'),
		parent2GermplasmId: uuid('parent2_germplasm_id').references(() => germplasm.id),
		parent2ObservationUnitId: uuid('parent2_observation_unit_id').references(
			() => observationUnit.id
		),
		parent2Type: parentType('parent2_type'),
		externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
		additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
		arcId: integer('arc_id')
			.notNull()
			.references(() => roCrateStaging.arcId, { onDelete: 'cascade' }),
		sourceId: text('source_id'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.arcId, table.sourceId)]
);

export const pedigreeNode = pgTable(
	'pedigree_node',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		germplasmId: uuid('germplasm_id')
			.notNull()
			.unique()
			.references(() => germplasm.id, { onDelete: 'cascade' }),
		breedingMethodId: uuid('breeding_method_id').references(() => breedingMethod.id),
		crossingProjectId: uuid('crossing_project_id').references(() => crossingProject.id),
		crossingYear: integer('crossing_year'),
		familyCode: text('family_code'),
		defaultDisplayName: text('default_display_name'),
		pedigreeString: text('pedigree_string'),
		externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
		additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
		arcId: integer('arc_id')
			.notNull()
			.references(() => roCrateStaging.arcId, { onDelete: 'cascade' }),
		sourceId: text('source_id'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.arcId, table.sourceId)]
);

export const pedigreeNodeParent = pgTable(
	'pedigree_node_parent',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		pedigreeNodeId: uuid('pedigree_node_id')
			.notNull()
			.references(() => pedigreeNode.id, { onDelete: 'cascade' }),
		germplasmId: uuid('germplasm_id')
			.notNull()
			.references(() => germplasm.id, { onDelete: 'cascade' }),
		parentType: parentType('parent_type').notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [unique().on(table.pedigreeNodeId, table.germplasmId)]
);

export const seedLot = pgTable(
	'seed_lot',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		locationId: uuid('location_id').references(() => location.id),
		programId: uuid('program_id').references(() => program.id),
		seedLotName: text('seed_lot_name').notNull(),
		seedLotDescription: text('seed_lot_description'),
		amount: numeric('amount'),
		units: text('units'),
		createdDate: date('created_date'),
		lastUpdated: timestamp('last_updated'),
		sourceCollection: text('source_collection'),
		storageLocation: text('storage_location'),
		externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
		additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
		arcId: integer('arc_id')
			.notNull()
			.references(() => roCrateStaging.arcId, { onDelete: 'cascade' }),
		sourceId: text('source_id'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.arcId, table.sourceId)]
);

export const seedLotContent = pgTable(
	'seed_lot_content',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		seedLotId: uuid('seed_lot_id')
			.notNull()
			.references(() => seedLot.id, { onDelete: 'cascade' }),
		germplasmId: uuid('germplasm_id').references(() => germplasm.id),
		crossId: uuid('cross_id').references(() => cross.id),
		mixturePercentage: integer('mixture_percentage'),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [unique().on(table.seedLotId, table.germplasmId, table.crossId)]
);

export const seedLotTransaction = pgTable(
	'seed_lot_transaction',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		fromSeedLotId: uuid('from_seed_lot_id').references(() => seedLot.id),
		toSeedLotId: uuid('to_seed_lot_id').references(() => seedLot.id),
		amount: numeric('amount'),
		units: text('units'),
		transactionTimestamp: timestamp('transaction_timestamp'),
		transactionDescription: text('transaction_description'),
		externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
		additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
		arcId: integer('arc_id')
			.notNull()
			.references(() => roCrateStaging.arcId, { onDelete: 'cascade' }),
		sourceId: text('source_id'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.arcId, table.sourceId)]
);

export const germplasmAttribute = pgTable('germplasm_attribute', {
	id: uuid('id').primaryKey().defaultRandom(),
	attributeName: text('attribute_name').notNull(),
	attributeCategory: text('attribute_category'),
	attributePui: text('attribute_pui').unique(),
	attributeDescription: text('attribute_description'),
	commonCropName: text('common_crop_name'),
	contextOfUse: jsonb('context_of_use').$type<string[]>(),
	defaultValue: text('default_value'),
	documentationUrl: text('documentation_url'),
	growthStage: text('growth_stage'),
	institution: text('institution'),
	language: text('language'),
	scientist: text('scientist'),
	status: text('status'),
	submissionTimestamp: timestamp('submission_timestamp'),
	synonyms: jsonb('synonyms').$type<string[]>(),
	traitId: uuid('trait_id')
		.notNull()
		.references(() => trait.id),
	methodId: uuid('method_id')
		.notNull()
		.references(() => method.id),
	scaleId: uuid('scale_id')
		.notNull()
		.references(() => scale.id),
	ontologyId: uuid('ontology_id').references(() => ontology.id),
	ontologyReference: jsonb('ontology_reference').$type<OntologyReference>(),
	externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
	additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

export const germplasmAttributeValue = pgTable(
	'germplasm_attribute_value',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		attributeId: uuid('attribute_id')
			.notNull()
			.references(() => germplasmAttribute.id),
		germplasmId: uuid('germplasm_id').references(() => germplasm.id),
		value: text('value'),
		determinedDate: date('determined_date'),
		externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
		additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
		arcId: integer('arc_id')
			.notNull()
			.references(() => roCrateStaging.arcId, { onDelete: 'cascade' }),
		sourceId: text('source_id'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.arcId, table.sourceId)]
);
