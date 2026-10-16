import { sql } from 'drizzle-orm';
import {
	pgTable,
	pgEnum,
	uuid,
	integer,
	text,
	timestamp,
	uniqueIndex,
	index
} from 'drizzle-orm/pg-core';
import { user } from '../auth/schema';

export const etlJobKind = pgEnum('etl_job_kind', ['full', 'transform', 'load']);
export const etlJobState = pgEnum('etl_job_state', ['queued', 'running', 'succeeded', 'failed']);
export const etlJobStep = pgEnum('etl_job_step', ['extract', 'transform', 'load']);

/** One row per requested import. Claimed by the worker with FOR UPDATE SKIP LOCKED; see
 *  docs/etl-worker.md. Deliberately no foreign key to ro_crate_staging: the staging row does not
 *  exist until the first Extract succeeds. */
export const etlJob = pgTable(
	'etl_job',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		arcId: integer('arc_id').notNull(),
		kind: etlJobKind('kind').notNull(),
		requestedBy: text('requested_by')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		state: etlJobState('state').notNull().default('queued'),
		currentStep: etlJobStep('current_step'),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(3),
		// A queued job is not claimed before this time (retry backoff).
		runAfter: timestamp('run_after', { withTimezone: true }).defaultNow().notNull(),
		lockedBy: text('locked_by'),
		leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
		// Last failure. Kept on a queued row that is waiting for a retry.
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		startedAt: timestamp('started_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		// At most one active job per ARC: a second request is deduplicated to the existing job.
		uniqueIndex('etl_job_one_active_per_arc')
			.on(table.arcId)
			.where(sql`${table.state} in ('queued', 'running')`),
		index('etl_job_arc_created_idx').on(table.arcId, table.createdAt, table.id)
	]
);

export type EtlJob = typeof etlJob.$inferSelect;
