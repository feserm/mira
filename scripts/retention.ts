/**
 * Deletes request_logs rows older than REQUEST_LOGS_RETENTION_DAYS (default 90), in batches, then exits.
 * Run by the chart's retention CronJob with the same image (`node retention.js`) and the app's DML-only
 * database role: it needs no DDL and no migration.
 *
 * Standalone like migrate.ts: it reads only DATABASE_URL, DB_SSL, REQUEST_LOGS_RETENTION_DAYS and
 * REQUEST_LOGS_RETENTION_BATCH, imports no SvelteKit module and not the app's env module (so no ORIGIN
 * or auth secrets). Bundled to build-retention/retention.js by `pnpm build:retention`.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { deleteExpiredRequestLogs, parseRetentionEnv } from '$lib/server/db/retention';
import { logger } from '$lib/server/log';

const SSL_MODES = ['require', 'allow', 'prefer', 'verify-full'] as const;
type SslMode = (typeof SSL_MODES)[number];

function fail(message: string): never {
	logger.error(`retention: ${message}`, { event: 'retention.failed' });
	process.exit(1);
}

function parseSsl(raw: string | undefined): SslMode | undefined {
	const value = (raw ?? '').trim().toLowerCase();
	if (value === 'true') return 'require';
	if (!value || value === 'false') return undefined;
	if ((SSL_MODES as readonly string[]).includes(value)) return value as SslMode;
	return fail(`DB_SSL must be one of true, false, ${SSL_MODES.join(', ')}`);
}

/** The real reason: drizzle wraps a driver error in "Failed query: <sql>", and a connection error is
 *  often an AggregateError with no message of its own (as in migrate.ts). */
function describe(error: unknown): string {
	if (error instanceof AggregateError && error.errors.length) {
		return error.errors.map(describe).join('; ');
	}
	if (error instanceof Error && error.cause) return describe(error.cause);
	if (error instanceof Error) {
		const code = (error as { code?: string }).code;
		return [code, error.message].filter(Boolean).join(' ') || error.name;
	}
	return String(error);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) fail('DATABASE_URL is not set');
if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
	fail('DATABASE_URL must be a postgres:// or postgresql:// URL');
}
const { config, errors } = parseRetentionEnv(process.env);
if (errors.length > 0) fail(errors.join('; '));

const client = postgres(databaseUrl, {
	max: 1,
	connect_timeout: 30,
	ssl: parseSsl(process.env.DB_SSL),
	onnotice: () => {}
});

const startedAt = Date.now();
try {
	const result = await deleteExpiredRequestLogs(drizzle(client), config);
	logger.info(
		`retention: deleted ${result.deleted} request_logs row(s) older than ${config.days} days in ${result.batches} batch(es)`,
		{
			event: 'retention.done',
			deleted: result.deleted,
			batches: result.batches,
			days: config.days,
			batchSize: config.batchSize,
			cutoff: result.cutoff.toISOString(),
			durationMs: Date.now() - startedAt
		}
	);
} catch (error) {
	logger.error(`retention: failed: ${describe(error)}`, {
		event: 'retention.failed',
		durationMs: Date.now() - startedAt
	});
	process.exitCode = 1;
} finally {
	await client.end({ timeout: 5 });
}
