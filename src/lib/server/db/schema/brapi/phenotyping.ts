import {
	pgTable,
	pgEnum,
	uuid,
	text,
	integer,
	timestamp,
	jsonb,
	unique,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { roCrateStaging } from '../staging/schema';
import type {
	ExternalReference,
	AdditionalInfo,
	OntologyReference,
	GeoJSON
} from '$lib/types/brapi/common';
import type {
	ScaleValidValues,
	ObservationUnitPosition,
	ObservationTreatment,
	EventDateRange,
	EventParameter
} from '$lib/types/brapi/phenotyping';
import { study, trial, program, location, season } from './core';
import { germplasm, seedLot, cross } from './germplasm';

export const traitDataType = pgEnum('trait_data_type', [
	'Code',
	'Date',
	'Duration',
	'Nominal',
	'Numerical',
	'Ordinal',
	'Text'
]);

export const ontology = pgTable(
	'ontology',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ontologyName: text('ontology_name').notNull(),
		description: text('description'),
		authors: text('authors'),
		copyright: text('copyright'),
		licence: text('licence'),
		version: text('version'),
		documentationUrl: text('documentation_url'),
		additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.ontologyName, table.version)]
);

export const trait = pgTable('trait', {
	id: uuid('id').primaryKey().defaultRandom(),
	traitName: text('trait_name').notNull(),
	traitDescription: text('trait_description'),
	traitClass: text('trait_class'),
	attribute: text('attribute'),
	attributePui: text('attribute_pui'),
	entity: text('entity'),
	entityPui: text('entity_pui'),
	mainAbbreviation: text('main_abbreviation'),
	alternativeAbbreviations: jsonb('alternative_abbreviations').$type<string[]>(),
	status: text('status'),
	synonyms: jsonb('synonyms').$type<string[]>(),
	traitPui: text('trait_pui').unique(),
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

export const method = pgTable('method', {
	id: uuid('id').primaryKey().defaultRandom(),
	methodName: text('method_name').notNull(),
	description: text('description'),
	methodClass: text('method_class'),
	formula: text('formula'),
	bibliographicalReference: text('bibliographical_reference'),
	methodPui: text('method_pui').unique(),
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

export const scale = pgTable('scale', {
	id: uuid('id').primaryKey().defaultRandom(),
	scaleName: text('scale_name').notNull(),
	scalePui: text('scale_pui').unique(),
	dataType: traitDataType('data_type'),
	decimalPlaces: integer('decimal_places'),
	units: text('units'),
	validValues: jsonb('valid_values').$type<ScaleValidValues>(),
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

export const observationVariable = pgTable('observation_variable', {
	id: uuid('id').primaryKey().defaultRandom(),
	observationVariableName: text('observation_variable_name').notNull(),
	observationVariablePui: text('observation_variable_pui').unique(),
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

export const studyObservationVariable = pgTable(
	'study_observation_variable',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		studyId: uuid('study_id')
			.notNull()
			.references(() => study.id, { onDelete: 'cascade' }),
		observationVariableId: uuid('observation_variable_id')
			.notNull()
			.references(() => observationVariable.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [unique().on(table.studyId, table.observationVariableId)]
);

export const observationUnit = pgTable(
	'observation_unit',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		germplasmId: uuid('germplasm_id').references(() => germplasm.id),
		seedLotId: uuid('seed_lot_id').references(() => seedLot.id),
		crossId: uuid('cross_id').references((): AnyPgColumn => cross.id),
		studyId: uuid('study_id').references(() => study.id),
		trialId: uuid('trial_id').references(() => trial.id),
		programId: uuid('program_id').references(() => program.id),
		locationId: uuid('location_id').references(() => location.id),
		observationUnitName: text('observation_unit_name'),
		observationUnitPui: text('observation_unit_pui'),
		observationUnitPosition: jsonb('observation_unit_position').$type<ObservationUnitPosition>(),
		treatments: jsonb('treatments').$type<ObservationTreatment[]>(),
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

export const observation = pgTable(
	'observation',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		germplasmId: uuid('germplasm_id').references(() => germplasm.id),
		observationUnitId: uuid('observation_unit_id').references(() => observationUnit.id),
		observationVariableId: uuid('observation_variable_id').references(() => observationVariable.id),
		studyId: uuid('study_id').references(() => study.id),
		seasonId: uuid('season_id').references(() => season.id),
		collector: text('collector'),
		observationTimestamp: timestamp('observation_timestamp'),
		uploadedBy: text('uploaded_by'),
		value: text('value'),
		geoCoordinates: jsonb('geo_coordinates').$type<GeoJSON>(),
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

export const image = pgTable(
	'image',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		observationUnitId: uuid('observation_unit_id').references(() => observationUnit.id),
		imageName: text('image_name'),
		imageFileName: text('image_file_name'),
		imageFileSize: integer('image_file_size'),
		imageHeight: integer('image_height'),
		imageWidth: integer('image_width'),
		mimeType: text('mime_type'),
		imageLocation: jsonb('image_location').$type<GeoJSON>(),
		imageTimestamp: timestamp('image_timestamp'),
		imageUrl: text('image_url'),
		copyright: text('copyright'),
		description: text('description'),
		imageContent: text('image_content'),
		descriptiveOntologyTerms: jsonb('descriptive_ontology_terms').$type<string[]>(),
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

export const observationImage = pgTable(
	'observation_image',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		observationId: uuid('observation_id')
			.notNull()
			.references(() => observation.id, { onDelete: 'cascade' }),
		imageId: uuid('image_id')
			.notNull()
			.references(() => image.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [unique().on(table.observationId, table.imageId)]
);

export const event = pgTable(
	'event',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		studyId: uuid('study_id').references(() => study.id),
		eventType: text('event_type').notNull(),
		eventTypeDbId: text('event_type_db_id'),
		eventDescription: text('event_description'),
		date: jsonb('date').$type<string[]>(),
		eventDateRange: jsonb('event_date_range').$type<EventDateRange>(),
		eventParameters: jsonb('event_parameters').$type<EventParameter[]>(),
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

export const eventObservationUnit = pgTable(
	'event_observation_unit',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		eventId: uuid('event_id')
			.notNull()
			.references(() => event.id, { onDelete: 'cascade' }),
		observationUnitId: uuid('observation_unit_id')
			.notNull()
			.references(() => observationUnit.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [unique().on(table.eventId, table.observationUnitId)]
);
