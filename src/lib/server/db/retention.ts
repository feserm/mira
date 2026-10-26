/** Deletes `request_logs` rows older than N days, in small batches, for the retention CronJob
 *  (`scripts/retention.ts`, chart `retention.*`). Plain SQL and a database handle passed in: no env
 *  module, no `$app`, so the job bundle stays small and the tests can hand it the DML-only test role.
 *
 *  Runs as the DML role: DELETE only, no DDL (the `created_at` index it relies on,
 *  `request_logs_created_at_idx`, has existed since the table was created). Each batch is its own short
 *  statement and transaction, so no lock is held across batches and inserts from the web pods are never
 *  blocked for longer than one batch. Re-running is harmless: a second run finds nothing to delete. */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_BATCH_SIZE = 5000;
const MAX_BATCH_SIZE = 100_000;
const DAY_MS = 86_400_000;

export interface RetentionConfig {
	days: number;
	batchSize: number;
}

/** Reads `REQUEST_LOGS_RETENTION_DAYS` and `REQUEST_LOGS_RETENTION_BATCH` (both optional). These belong
 *  to the retention job only: the web app and the worker do not read them. */
export function parseRetentionEnv(env: Record<string, string | undefined>): {
	config: RetentionConfig;
	errors: string[];
} {
	const errors: string[] = [];
	const integer = (name: string, fallback: number, min: number, max: number) => {
		const raw = env[name]?.trim();
		if (!raw) return fallback;
		const value = Number(raw);
		if (!Number.isInteger(value) || value < min || value > max) {
			errors.push(`${name} must be an integer from ${min} to ${max}`);
			return fallback;
		}
		return value;
	};
	return {
		config: {
			days: integer('REQUEST_LOGS_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, 1, 36_500),
			batchSize: integer('REQUEST_LOGS_RETENTION_BATCH', DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE)
		},
		errors
	};
}

export interface RetentionResult {
	/** rows removed */
	deleted: number;
	/** delete statements that removed at least one row */
	batches: number;
	/** rows older than this were eligible */
	cutoff: Date;
}

export interface RetentionOptions extends RetentionConfig {
	now?: Date;
	/** Pause between batches, so a large backlog does not saturate the disk. Default 100 ms. */
	pauseMs?: number;
}

export async function deleteExpiredRequestLogs(
	db: PostgresJsDatabase<Record<string, unknown>>,
	{ days, batchSize, now = new Date(), pauseMs = 100 }: RetentionOptions
): Promise<RetentionResult> {
	const cutoff = new Date(now.getTime() - days * DAY_MS);
	let deleted = 0;
	let batches = 0;

	for (;;) {
		// The subselect picks the oldest rows through the created_at index; the delete then removes
		// exactly those ids. `returning` gives the row count without a second query.
		const removed = await db.execute<{ id: string }>(sql`
			delete from request_logs
			where id in (
				select id from request_logs
				where created_at < ${cutoff.toISOString()}::timestamptz
				order by created_at
				limit ${batchSize}
			)
			returning id`);
		if (removed.length === 0) break;
		deleted += removed.length;
		batches++;
		if (removed.length < batchSize) break;
		if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
	}

	return { deleted, batches, cutoff };
}
