import {
	pgTable,
	pgEnum,
	uuid,
	text,
	integer,
	boolean,
	timestamp,
	date,
	jsonb,
	unique,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { roCrateStaging } from '../staging/schema';
import type { ExternalReference, AdditionalInfo, GeoJSON } from '$lib/types/brapi/common';
import type {
	Publication,
	DatasetAuthorship,
	ObservationLevel,
	ExperimentalDesign,
	GrowthFacility,
	StudyLastUpdate
} from '$lib/types/brapi/core';

export const programType = pgEnum('program_type', ['STANDARD', 'PROJECT']);

export const person = pgTable('person', {
	id: uuid('id').primaryKey().defaultRandom(),
	firstName: text('first_name'),
	lastName: text('last_name'),
	middleName: text('middle_name'),
	emailAddress: text('email_address').unique(),
	phoneNumber: text('phone_number'),
	mailingAddress: text('mailing_address'),
	description: text('description'),
	externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
	additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

export const contact = pgTable('contact', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name'),
	email: text('email'),
	instituteName: text('institute_name'),
	orcid: text('orcid').unique(),
	type: text('type'),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

export const season = pgTable(
	'season',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		seasonName: text('season_name'),
		year: integer('year'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.seasonName, table.year)]
);

export const location = pgTable(
	'location',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		abbreviation: text('abbreviation'),
		locationType: text('location_type'),
		parentLocationId: uuid('parent_location_id').references((): AnyPgColumn => location.id),
		countryCode: text('country_code'),
		countryName: text('country_name'),
		instituteName: text('institute_name'),
		instituteAddress: text('institute_address'),
		environmentType: text('environment_type'),
		exposure: text('exposure'),
		siteStatus: text('site_status'),
		slope: text('slope'),
		topography: text('topography'),
		coordinateDescription: text('coordinate_description'),
		coordinateUncertainty: text('coordinate_uncertainty'),
		coordinates: jsonb('coordinates').$type<GeoJSON>(),
		documentationUrl: text('documentation_url'),
		externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
		additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.name, table.instituteName)]
);

export const program = pgTable('program', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull().unique(),
	abbreviation: text('abbreviation'),
	commonCropName: text('common_crop_name'),
	documentationUrl: text('documentation_url'),
	fundingInformation: text('funding_information'),
	objective: text('objective'),
	programType: programType('program_type'),
	leadPersonId: uuid('lead_person_id').references(() => person.id),
	externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
	additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});

export const trial = pgTable(
	'trial',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		programId: uuid('program_id').references(() => program.id),
		name: text('name').notNull(),
		description: text('description'),
		active: boolean('active'),
		commonCropName: text('common_crop_name'),
		documentationUrl: text('documentation_url'),
		startDate: date('start_date'),
		endDate: date('end_date'),
		trialPui: text('trial_pui'),
		publications: jsonb('publications').$type<Publication[]>(),
		datasetAuthorships: jsonb('dataset_authorships').$type<DatasetAuthorship[]>(),
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

export const trialContact = pgTable(
	'trial_contact',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		trialId: uuid('trial_id')
			.notNull()
			.references(() => trial.id, { onDelete: 'cascade' }),
		contactId: uuid('contact_id')
			.notNull()
			.references(() => contact.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [unique().on(table.trialId, table.contactId)]
);

export const study = pgTable(
	'study',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		trialId: uuid('trial_id').references(() => trial.id),
		locationId: uuid('location_id').references(() => location.id),
		name: text('name').notNull(),
		description: text('description'),
		studyCode: text('study_code'),
		studyPui: text('study_pui'),
		studyType: text('study_type'),
		commonCropName: text('common_crop_name'),
		active: boolean('active'),
		startDate: date('start_date'),
		endDate: date('end_date'),
		culturalPractices: text('cultural_practices'),
		documentationUrl: text('documentation_url'),
		license: text('license'),
		observationUnitsDescription: text('observation_units_description'),
		observationLevels: jsonb('observation_levels').$type<ObservationLevel[]>(),
		experimentalDesign: jsonb('experimental_design').$type<ExperimentalDesign>(),
		growthFacility: jsonb('growth_facility').$type<GrowthFacility>(),
		lastUpdate: jsonb('last_update').$type<StudyLastUpdate>(),
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

export const studyContact = pgTable(
	'study_contact',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		studyId: uuid('study_id')
			.notNull()
			.references(() => study.id, { onDelete: 'cascade' }),
		contactId: uuid('contact_id')
			.notNull()
			.references(() => contact.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [unique().on(table.studyId, table.contactId)]
);

export const studySeason = pgTable(
	'study_season',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		studyId: uuid('study_id')
			.notNull()
			.references(() => study.id, { onDelete: 'cascade' }),
		seasonId: uuid('season_id')
			.notNull()
			.references(() => season.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [unique().on(table.studyId, table.seasonId)]
);

export const list = pgTable('list', {
	id: uuid('id').primaryKey().defaultRandom(),
	listName: text('list_name').notNull(),
	listDescription: text('list_description'),
	listType: text('list_type').notNull(),
	listOwnerPersonId: uuid('list_owner_person_id').references(() => person.id),
	listOwnerName: text('list_owner_name'),
	data: text('data').array(),
	externalReferences: jsonb('external_references').$type<ExternalReference[]>(),
	additionalInfo: jsonb('additional_info').$type<AdditionalInfo>(),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull()
});
