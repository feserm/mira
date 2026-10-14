CREATE TYPE "public"."program_type" AS ENUM('STANDARD', 'PROJECT');--> statement-breakpoint
CREATE TYPE "public"."cross_type" AS ENUM('BIPARENTAL', 'SELF', 'OPEN_POLLINATED', 'BULK', 'BULK_SELFED', 'BULK_OPEN_POLLINATED', 'DOUBLE_HAPLOID');--> statement-breakpoint
CREATE TYPE "public"."parent_type" AS ENUM('MALE', 'FEMALE', 'SELF', 'POPULATION', 'CLONAL');--> statement-breakpoint
CREATE TYPE "public"."planned_cross_status" AS ENUM('TODO', 'DONE', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."trait_data_type" AS ENUM('Code', 'Date', 'Duration', 'Nominal', 'Numerical', 'Ordinal', 'Text');--> statement-breakpoint
CREATE TYPE "public"."etl_step_status" AS ENUM('pending', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"institute_name" text,
	"orcid" text,
	"type" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contact_email_unique" UNIQUE("email"),
	CONSTRAINT "contact_orcid_unique" UNIQUE("orcid")
);
--> statement-breakpoint
CREATE TABLE "list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_name" text NOT NULL,
	"list_description" text,
	"list_type" text NOT NULL,
	"list_owner_person_id" uuid,
	"list_owner_name" text,
	"data" text[],
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"abbreviation" text,
	"location_type" text,
	"parent_location_id" uuid,
	"country_code" text,
	"country_name" text,
	"institute_name" text,
	"institute_address" text,
	"environment_type" text,
	"exposure" text,
	"site_status" text,
	"slope" text,
	"topography" text,
	"coordinate_description" text,
	"coordinate_uncertainty" text,
	"coordinates" jsonb,
	"documentation_url" text,
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "location_name_institute_name_unique" UNIQUE("name","institute_name")
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text,
	"last_name" text,
	"middle_name" text,
	"email_address" text,
	"phone_number" text,
	"mailing_address" text,
	"description" text,
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "person_email_address_unique" UNIQUE("email_address")
);
--> statement-breakpoint
CREATE TABLE "program" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"abbreviation" text,
	"common_crop_name" text,
	"documentation_url" text,
	"funding_information" text,
	"objective" text,
	"program_type" "program_type",
	"lead_person_id" uuid,
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "program_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "season" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_name" text,
	"year" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "season_season_name_year_unique" UNIQUE("season_name","year")
);
--> statement-breakpoint
CREATE TABLE "study" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trial_id" uuid,
	"location_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"study_code" text,
	"study_pui" text,
	"study_type" text,
	"common_crop_name" text,
	"active" boolean,
	"start_date" date,
	"end_date" date,
	"cultural_practices" text,
	"documentation_url" text,
	"license" text,
	"observation_units_description" text,
	"observation_levels" jsonb,
	"experimental_design" jsonb,
	"growth_facility" jsonb,
	"last_update" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "study_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "study_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "study_contact_study_id_contact_id_unique" UNIQUE("study_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "study_season" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "study_season_study_id_season_id_unique" UNIQUE("study_id","season_id")
);
--> statement-breakpoint
CREATE TABLE "trial" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"active" boolean,
	"common_crop_name" text,
	"documentation_url" text,
	"start_date" date,
	"end_date" date,
	"trial_pui" text,
	"publications" jsonb,
	"dataset_authorships" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trial_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "trial_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trial_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trial_contact_trial_id_contact_id_unique" UNIQUE("trial_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "breeding_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"abbreviation" text,
	"breeding_method_name" text,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "breeding_method_breeding_method_name_unique" UNIQUE("breeding_method_name")
);
--> statement-breakpoint
CREATE TABLE "cross" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crossing_project_id" uuid,
	"cross_name" text,
	"cross_type" "cross_type",
	"parent1_germplasm_id" uuid,
	"parent1_observation_unit_id" uuid,
	"parent1_type" "parent_type",
	"parent2_germplasm_id" uuid,
	"parent2_observation_unit_id" uuid,
	"parent2_type" "parent_type",
	"pollination_timestamp" timestamp,
	"cross_attributes" jsonb,
	"pollination_events" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cross_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "crossing_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid,
	"crossing_project_name" text NOT NULL,
	"crossing_project_description" text,
	"common_crop_name" text,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crossing_project_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "crossing_project_potential_parent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crossing_project_id" uuid NOT NULL,
	"germplasm_id" uuid,
	"observation_unit_id" uuid,
	"parent_type" "parent_type",
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crossing_project_potential_parent_crossing_project_id_germplasm_id_observation_unit_id_unique" UNIQUE("crossing_project_id","germplasm_id","observation_unit_id")
);
--> statement-breakpoint
CREATE TABLE "germplasm" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"germplasm_name" text NOT NULL,
	"germplasm_pui" text NOT NULL,
	"default_display_name" text,
	"accession_number" text,
	"acquisition_date" date,
	"biological_status_of_accession_code" text,
	"biological_status_of_accession_description" text,
	"breeding_method_id" uuid,
	"collection" text,
	"common_crop_name" text NOT NULL,
	"country_of_origin_code" text,
	"documentation_url" text,
	"genus" text,
	"germplasm_preprocessing" text,
	"institute_code" text,
	"institute_name" text,
	"pedigree" text,
	"seed_source" text,
	"seed_source_description" text,
	"species" text,
	"species_authority" text,
	"subtaxa" text,
	"subtaxa_authority" text,
	"donors" jsonb,
	"storage_types" jsonb,
	"synonyms" jsonb,
	"taxon_ids" jsonb,
	"germplasm_origin" jsonb,
	"mcpd" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "germplasm_germplasm_pui_unique" UNIQUE("germplasm_pui")
);
--> statement-breakpoint
CREATE TABLE "germplasm_attribute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attribute_name" text NOT NULL,
	"attribute_category" text,
	"attribute_pui" text,
	"attribute_description" text,
	"common_crop_name" text,
	"context_of_use" jsonb,
	"default_value" text,
	"documentation_url" text,
	"growth_stage" text,
	"institution" text,
	"language" text,
	"scientist" text,
	"status" text,
	"submission_timestamp" timestamp,
	"synonyms" jsonb,
	"trait_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
	"scale_id" uuid NOT NULL,
	"ontology_id" uuid,
	"ontology_reference" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "germplasm_attribute_attribute_pui_unique" UNIQUE("attribute_pui")
);
--> statement-breakpoint
CREATE TABLE "germplasm_attribute_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attribute_id" uuid NOT NULL,
	"germplasm_id" uuid,
	"value" text,
	"determined_date" date,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "germplasm_attribute_value_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "pedigree_node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"germplasm_id" uuid NOT NULL,
	"breeding_method_id" uuid,
	"crossing_project_id" uuid,
	"crossing_year" integer,
	"family_code" text,
	"default_display_name" text,
	"pedigree_string" text,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pedigree_node_germplasm_id_unique" UNIQUE("germplasm_id"),
	CONSTRAINT "pedigree_node_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "pedigree_node_parent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pedigree_node_id" uuid NOT NULL,
	"germplasm_id" uuid NOT NULL,
	"parent_type" "parent_type" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pedigree_node_parent_pedigree_node_id_germplasm_id_unique" UNIQUE("pedigree_node_id","germplasm_id")
);
--> statement-breakpoint
CREATE TABLE "planned_cross" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crossing_project_id" uuid,
	"planned_cross_name" text,
	"cross_type" "cross_type",
	"status" "planned_cross_status",
	"parent1_germplasm_id" uuid,
	"parent1_observation_unit_id" uuid,
	"parent1_type" "parent_type",
	"parent2_germplasm_id" uuid,
	"parent2_observation_unit_id" uuid,
	"parent2_type" "parent_type",
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "planned_cross_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "seed_lot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid,
	"program_id" uuid,
	"seed_lot_name" text NOT NULL,
	"seed_lot_description" text,
	"amount" numeric,
	"units" text,
	"created_date" date,
	"last_updated" timestamp,
	"source_collection" text,
	"storage_location" text,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "seed_lot_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "seed_lot_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seed_lot_id" uuid NOT NULL,
	"germplasm_id" uuid,
	"cross_id" uuid,
	"mixture_percentage" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "seed_lot_content_seed_lot_id_germplasm_id_cross_id_unique" UNIQUE("seed_lot_id","germplasm_id","cross_id")
);
--> statement-breakpoint
CREATE TABLE "seed_lot_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_seed_lot_id" uuid,
	"to_seed_lot_id" uuid,
	"amount" numeric,
	"units" text,
	"transaction_timestamp" timestamp,
	"transaction_description" text,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "seed_lot_transaction_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid,
	"event_type" text NOT NULL,
	"event_type_db_id" text,
	"event_description" text,
	"date" jsonb,
	"event_date_range" jsonb,
	"event_parameters" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "event_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "event_observation_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"observation_unit_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "event_observation_unit_event_id_observation_unit_id_unique" UNIQUE("event_id","observation_unit_id")
);
--> statement-breakpoint
CREATE TABLE "image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_unit_id" uuid,
	"image_name" text,
	"image_file_name" text,
	"image_file_size" integer,
	"image_height" integer,
	"image_width" integer,
	"mime_type" text,
	"image_location" jsonb,
	"image_timestamp" timestamp,
	"image_url" text,
	"copyright" text,
	"description" text,
	"image_content" text,
	"descriptive_ontology_terms" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "image_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"method_name" text NOT NULL,
	"description" text,
	"method_class" text,
	"formula" text,
	"bibliographical_reference" text,
	"method_pui" text,
	"ontology_id" uuid,
	"ontology_reference" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "method_method_pui_unique" UNIQUE("method_pui")
);
--> statement-breakpoint
CREATE TABLE "observation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"germplasm_id" uuid,
	"observation_unit_id" uuid,
	"observation_variable_id" uuid,
	"study_id" uuid,
	"season_id" uuid,
	"collector" text,
	"observation_timestamp" timestamp,
	"uploaded_by" text,
	"value" text,
	"geo_coordinates" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "observation_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "observation_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "observation_image_observation_id_image_id_unique" UNIQUE("observation_id","image_id")
);
--> statement-breakpoint
CREATE TABLE "observation_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"germplasm_id" uuid,
	"seed_lot_id" uuid,
	"cross_id" uuid,
	"study_id" uuid,
	"trial_id" uuid,
	"program_id" uuid,
	"location_id" uuid,
	"observation_unit_name" text,
	"observation_unit_pui" text,
	"observation_unit_position" jsonb,
	"treatments" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"arc_id" integer NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "observation_unit_arc_id_source_id_unique" UNIQUE("arc_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "observation_variable" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_variable_name" text NOT NULL,
	"observation_variable_pui" text,
	"common_crop_name" text,
	"context_of_use" jsonb,
	"default_value" text,
	"documentation_url" text,
	"growth_stage" text,
	"institution" text,
	"language" text,
	"scientist" text,
	"status" text,
	"submission_timestamp" timestamp,
	"synonyms" jsonb,
	"trait_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
	"scale_id" uuid NOT NULL,
	"ontology_id" uuid,
	"ontology_reference" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "observation_variable_observation_variable_pui_unique" UNIQUE("observation_variable_pui")
);
--> statement-breakpoint
CREATE TABLE "ontology" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ontology_name" text NOT NULL,
	"description" text,
	"authors" text,
	"copyright" text,
	"licence" text,
	"version" text,
	"documentation_url" text,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ontology_ontology_name_version_unique" UNIQUE("ontology_name","version")
);
--> statement-breakpoint
CREATE TABLE "scale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scale_name" text NOT NULL,
	"scale_pui" text,
	"data_type" "trait_data_type",
	"decimal_places" integer,
	"units" text,
	"valid_values" jsonb,
	"ontology_id" uuid,
	"ontology_reference" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scale_scale_pui_unique" UNIQUE("scale_pui")
);
--> statement-breakpoint
CREATE TABLE "study_observation_variable" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"observation_variable_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "study_observation_variable_study_id_observation_variable_id_unique" UNIQUE("study_id","observation_variable_id")
);
--> statement-breakpoint
CREATE TABLE "trait" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trait_name" text NOT NULL,
	"trait_description" text,
	"trait_class" text,
	"attribute" text,
	"attribute_pui" text,
	"entity" text,
	"entity_pui" text,
	"main_abbreviation" text,
	"alternative_abbreviations" jsonb,
	"status" text,
	"synonyms" jsonb,
	"trait_pui" text,
	"ontology_id" uuid,
	"ontology_reference" jsonb,
	"external_references" jsonb,
	"additional_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trait_trait_pui_unique" UNIQUE("trait_pui")
);
--> statement-breakpoint
CREATE TABLE "user_dashboards" (
	"user_id" text PRIMARY KEY NOT NULL,
	"layout" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ro_crate_staging" (
	"arc_id" integer PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"raw_ro_crate" jsonb,
	"extract_status" "etl_step_status" DEFAULT 'pending' NOT NULL,
	"extracted_at" timestamp,
	"extracted_by" text,
	"extract_error" text,
	"transform_status" "etl_step_status" DEFAULT 'pending' NOT NULL,
	"transformed_at" timestamp,
	"transformed_by" text,
	"transform_error" text,
	"load_status" "etl_step_status" DEFAULT 'pending' NOT NULL,
	"loaded_at" timestamp,
	"loaded_by" text,
	"load_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ro_crate_staging_path_unique" UNIQUE("path")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list" ADD CONSTRAINT "list_list_owner_person_id_person_id_fk" FOREIGN KEY ("list_owner_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_parent_location_id_location_id_fk" FOREIGN KEY ("parent_location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program" ADD CONSTRAINT "program_lead_person_id_person_id_fk" FOREIGN KEY ("lead_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study" ADD CONSTRAINT "study_trial_id_trial_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trial"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study" ADD CONSTRAINT "study_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study" ADD CONSTRAINT "study_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_contact" ADD CONSTRAINT "study_contact_study_id_study_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_contact" ADD CONSTRAINT "study_contact_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_season" ADD CONSTRAINT "study_season_study_id_study_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_season" ADD CONSTRAINT "study_season_season_id_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."season"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial" ADD CONSTRAINT "trial_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial" ADD CONSTRAINT "trial_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_contact" ADD CONSTRAINT "trial_contact_trial_id_trial_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trial"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_contact" ADD CONSTRAINT "trial_contact_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross" ADD CONSTRAINT "cross_crossing_project_id_crossing_project_id_fk" FOREIGN KEY ("crossing_project_id") REFERENCES "public"."crossing_project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross" ADD CONSTRAINT "cross_parent1_germplasm_id_germplasm_id_fk" FOREIGN KEY ("parent1_germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross" ADD CONSTRAINT "cross_parent1_observation_unit_id_observation_unit_id_fk" FOREIGN KEY ("parent1_observation_unit_id") REFERENCES "public"."observation_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross" ADD CONSTRAINT "cross_parent2_germplasm_id_germplasm_id_fk" FOREIGN KEY ("parent2_germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross" ADD CONSTRAINT "cross_parent2_observation_unit_id_observation_unit_id_fk" FOREIGN KEY ("parent2_observation_unit_id") REFERENCES "public"."observation_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross" ADD CONSTRAINT "cross_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crossing_project" ADD CONSTRAINT "crossing_project_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crossing_project" ADD CONSTRAINT "crossing_project_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crossing_project_potential_parent" ADD CONSTRAINT "crossing_project_potential_parent_crossing_project_id_crossing_project_id_fk" FOREIGN KEY ("crossing_project_id") REFERENCES "public"."crossing_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crossing_project_potential_parent" ADD CONSTRAINT "crossing_project_potential_parent_germplasm_id_germplasm_id_fk" FOREIGN KEY ("germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crossing_project_potential_parent" ADD CONSTRAINT "crossing_project_potential_parent_observation_unit_id_observation_unit_id_fk" FOREIGN KEY ("observation_unit_id") REFERENCES "public"."observation_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germplasm" ADD CONSTRAINT "germplasm_breeding_method_id_breeding_method_id_fk" FOREIGN KEY ("breeding_method_id") REFERENCES "public"."breeding_method"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germplasm_attribute" ADD CONSTRAINT "germplasm_attribute_trait_id_trait_id_fk" FOREIGN KEY ("trait_id") REFERENCES "public"."trait"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germplasm_attribute" ADD CONSTRAINT "germplasm_attribute_method_id_method_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."method"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germplasm_attribute" ADD CONSTRAINT "germplasm_attribute_scale_id_scale_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germplasm_attribute" ADD CONSTRAINT "germplasm_attribute_ontology_id_ontology_id_fk" FOREIGN KEY ("ontology_id") REFERENCES "public"."ontology"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germplasm_attribute_value" ADD CONSTRAINT "germplasm_attribute_value_attribute_id_germplasm_attribute_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."germplasm_attribute"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germplasm_attribute_value" ADD CONSTRAINT "germplasm_attribute_value_germplasm_id_germplasm_id_fk" FOREIGN KEY ("germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germplasm_attribute_value" ADD CONSTRAINT "germplasm_attribute_value_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedigree_node" ADD CONSTRAINT "pedigree_node_germplasm_id_germplasm_id_fk" FOREIGN KEY ("germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedigree_node" ADD CONSTRAINT "pedigree_node_breeding_method_id_breeding_method_id_fk" FOREIGN KEY ("breeding_method_id") REFERENCES "public"."breeding_method"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedigree_node" ADD CONSTRAINT "pedigree_node_crossing_project_id_crossing_project_id_fk" FOREIGN KEY ("crossing_project_id") REFERENCES "public"."crossing_project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedigree_node" ADD CONSTRAINT "pedigree_node_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedigree_node_parent" ADD CONSTRAINT "pedigree_node_parent_pedigree_node_id_pedigree_node_id_fk" FOREIGN KEY ("pedigree_node_id") REFERENCES "public"."pedigree_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedigree_node_parent" ADD CONSTRAINT "pedigree_node_parent_germplasm_id_germplasm_id_fk" FOREIGN KEY ("germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_cross" ADD CONSTRAINT "planned_cross_crossing_project_id_crossing_project_id_fk" FOREIGN KEY ("crossing_project_id") REFERENCES "public"."crossing_project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_cross" ADD CONSTRAINT "planned_cross_parent1_germplasm_id_germplasm_id_fk" FOREIGN KEY ("parent1_germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_cross" ADD CONSTRAINT "planned_cross_parent1_observation_unit_id_observation_unit_id_fk" FOREIGN KEY ("parent1_observation_unit_id") REFERENCES "public"."observation_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_cross" ADD CONSTRAINT "planned_cross_parent2_germplasm_id_germplasm_id_fk" FOREIGN KEY ("parent2_germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_cross" ADD CONSTRAINT "planned_cross_parent2_observation_unit_id_observation_unit_id_fk" FOREIGN KEY ("parent2_observation_unit_id") REFERENCES "public"."observation_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_cross" ADD CONSTRAINT "planned_cross_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_lot" ADD CONSTRAINT "seed_lot_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_lot" ADD CONSTRAINT "seed_lot_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_lot" ADD CONSTRAINT "seed_lot_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_lot_content" ADD CONSTRAINT "seed_lot_content_seed_lot_id_seed_lot_id_fk" FOREIGN KEY ("seed_lot_id") REFERENCES "public"."seed_lot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_lot_content" ADD CONSTRAINT "seed_lot_content_germplasm_id_germplasm_id_fk" FOREIGN KEY ("germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_lot_content" ADD CONSTRAINT "seed_lot_content_cross_id_cross_id_fk" FOREIGN KEY ("cross_id") REFERENCES "public"."cross"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_lot_transaction" ADD CONSTRAINT "seed_lot_transaction_from_seed_lot_id_seed_lot_id_fk" FOREIGN KEY ("from_seed_lot_id") REFERENCES "public"."seed_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_lot_transaction" ADD CONSTRAINT "seed_lot_transaction_to_seed_lot_id_seed_lot_id_fk" FOREIGN KEY ("to_seed_lot_id") REFERENCES "public"."seed_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_lot_transaction" ADD CONSTRAINT "seed_lot_transaction_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_study_id_study_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."study"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_observation_unit" ADD CONSTRAINT "event_observation_unit_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_observation_unit" ADD CONSTRAINT "event_observation_unit_observation_unit_id_observation_unit_id_fk" FOREIGN KEY ("observation_unit_id") REFERENCES "public"."observation_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image" ADD CONSTRAINT "image_observation_unit_id_observation_unit_id_fk" FOREIGN KEY ("observation_unit_id") REFERENCES "public"."observation_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image" ADD CONSTRAINT "image_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method" ADD CONSTRAINT "method_ontology_id_ontology_id_fk" FOREIGN KEY ("ontology_id") REFERENCES "public"."ontology"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_germplasm_id_germplasm_id_fk" FOREIGN KEY ("germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_observation_unit_id_observation_unit_id_fk" FOREIGN KEY ("observation_unit_id") REFERENCES "public"."observation_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_observation_variable_id_observation_variable_id_fk" FOREIGN KEY ("observation_variable_id") REFERENCES "public"."observation_variable"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_study_id_study_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."study"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_season_id_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."season"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_image" ADD CONSTRAINT "observation_image_observation_id_observation_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_image" ADD CONSTRAINT "observation_image_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_unit" ADD CONSTRAINT "observation_unit_germplasm_id_germplasm_id_fk" FOREIGN KEY ("germplasm_id") REFERENCES "public"."germplasm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_unit" ADD CONSTRAINT "observation_unit_seed_lot_id_seed_lot_id_fk" FOREIGN KEY ("seed_lot_id") REFERENCES "public"."seed_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_unit" ADD CONSTRAINT "observation_unit_cross_id_cross_id_fk" FOREIGN KEY ("cross_id") REFERENCES "public"."cross"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_unit" ADD CONSTRAINT "observation_unit_study_id_study_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."study"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_unit" ADD CONSTRAINT "observation_unit_trial_id_trial_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."trial"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_unit" ADD CONSTRAINT "observation_unit_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_unit" ADD CONSTRAINT "observation_unit_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_unit" ADD CONSTRAINT "observation_unit_arc_id_ro_crate_staging_arc_id_fk" FOREIGN KEY ("arc_id") REFERENCES "public"."ro_crate_staging"("arc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_variable" ADD CONSTRAINT "observation_variable_trait_id_trait_id_fk" FOREIGN KEY ("trait_id") REFERENCES "public"."trait"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_variable" ADD CONSTRAINT "observation_variable_method_id_method_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."method"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_variable" ADD CONSTRAINT "observation_variable_scale_id_scale_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_variable" ADD CONSTRAINT "observation_variable_ontology_id_ontology_id_fk" FOREIGN KEY ("ontology_id") REFERENCES "public"."ontology"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale" ADD CONSTRAINT "scale_ontology_id_ontology_id_fk" FOREIGN KEY ("ontology_id") REFERENCES "public"."ontology"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_observation_variable" ADD CONSTRAINT "study_observation_variable_study_id_study_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_observation_variable" ADD CONSTRAINT "study_observation_variable_observation_variable_id_observation_variable_id_fk" FOREIGN KEY ("observation_variable_id") REFERENCES "public"."observation_variable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trait" ADD CONSTRAINT "trait_ontology_id_ontology_id_fk" FOREIGN KEY ("ontology_id") REFERENCES "public"."ontology"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ro_crate_staging" ADD CONSTRAINT "ro_crate_staging_extracted_by_user_id_fk" FOREIGN KEY ("extracted_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ro_crate_staging" ADD CONSTRAINT "ro_crate_staging_transformed_by_user_id_fk" FOREIGN KEY ("transformed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ro_crate_staging" ADD CONSTRAINT "ro_crate_staging_loaded_by_user_id_fk" FOREIGN KEY ("loaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_name_institute_unique" ON "contact" USING btree ("name","institute_name") WHERE "contact"."orcid" is null and "contact"."email" is null;