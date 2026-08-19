import { pgTable, pgEnum, integer, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { user } from '../auth/schema';

export const etlStepStatus = pgEnum('etl_step_status', ['pending', 'success', 'failed']);

export const roCrateStaging = pgTable(
	'ro_crate_staging',
	{
		arcId: integer('arc_id').primaryKey(),
		// GitLab project `path` (URL slug) at last successful extract. Populated from
		// PLANTdataHUB rather than user input so BrAPI routes can resolve a repo-name
		// URL segment (e.g. `/SHAPE/brapi/v2/trials`) to an arcId without a live,
		// per-request GitLab lookup.
		path: text('path').notNull(),
		rawRoCrate: jsonb('raw_ro_crate'),

		extractStatus: etlStepStatus('extract_status').notNull().default('pending'),
		extractedAt: timestamp('extracted_at'),
		extractedBy: text('extracted_by').references(() => user.id, { onDelete: 'cascade' }),
		extractError: text('extract_error'),

		transformStatus: etlStepStatus('transform_status').notNull().default('pending'),
		transformedAt: timestamp('transformed_at'),
		transformedBy: text('transformed_by').references(() => user.id),
		transformError: text('transform_error'),

		loadStatus: etlStepStatus('load_status').notNull().default('pending'),
		loadedAt: timestamp('loaded_at'),
		loadedBy: text('loaded_by').references(() => user.id),
		loadError: text('load_error'),

		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique().on(table.path)]
);
