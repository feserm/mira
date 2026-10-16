/**
 * Applies the SQL migrations in ./drizzle to DATABASE_URL, then exits.
 *
 * Deliberately standalone: it reads only DATABASE_URL (plus the optional DB_SSL and
 * MIGRATIONS_FOLDER), does not import the app's env module and uses no SvelteKit modules, so it
 * runs without ORIGIN or the auth secrets. Bundled to build-migrate/migrate.js by
 * `pnpm build:migrate`. Run it as a Job or initContainer, never at app boot.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const SSL_MODES = ['require', 'allow', 'prefer', 'verify-full'] as const;
type SslMode = (typeof SSL_MODES)[number];

function fail(message: string): never {
	console.error(`migrate: ${message}`);
	process.exit(1);
}

function parseSsl(raw: string | undefined): SslMode | undefined {
	const value = (raw ?? '').trim().toLowerCase();
	if (value === 'true') return 'require';
	if (!value || value === 'false') return undefined;
	if ((SSL_MODES as readonly string[]).includes(value)) return value as SslMode;
	return fail(`DB_SSL must be one of true, false, ${SSL_MODES.join(', ')} (got "${raw}")`);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) fail('DATABASE_URL is not set');
if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
	fail('DATABASE_URL must be a postgres:// or postgresql:// URL');
}

const migrationsFolder = path.resolve(process.env.MIGRATIONS_FOLDER ?? 'drizzle');
const journal: { entries: { tag: string; when: number }[] } = JSON.parse(
	readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
);

// A single connection: migrations run sequentially in one transaction.
const client = postgres(databaseUrl, {
	max: 1,
	connect_timeout: 30,
	ssl: parseSsl(process.env.DB_SSL),
	onnotice: () => {}
});

/** connection errors are often an AggregateError (one per resolved address) with no message */
function describe(error: unknown): string {
	if (error instanceof AggregateError && error.errors.length) {
		return error.errors.map(describe).join('; ');
	}
	if (error instanceof Error) {
		const code = (error as { code?: string }).code;
		return [code, error.message].filter(Boolean).join(' ') || error.name;
	}
	return String(error);
}

/** `created_at` values (the journal's `when`) of migrations already recorded, or empty if none. */
async function appliedTimestamps(): Promise<Set<number>> {
	const [{ exists }] =
		await client`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
	if (!exists) return new Set();
	const rows = await client`select created_at from drizzle.__drizzle_migrations`;
	return new Set(rows.map((row) => Number(row.created_at)));
}

try {
	const before = await appliedTimestamps();
	await migrate(drizzle(client), { migrationsFolder });
	const after = await appliedTimestamps();

	const ran = journal.entries.filter((e) => after.has(e.when) && !before.has(e.when));
	for (const entry of ran) console.log(`migrate: applied ${entry.tag}`);
	console.log(
		ran.length
			? `migrate: done, ${ran.length} applied, ${before.size} already present`
			: `migrate: nothing to apply, ${before.size} already present`
	);
} catch (error) {
	console.error(`migrate: failed: ${describe(error)}`);
	if (error instanceof Error && error.cause)
		console.error(`migrate: cause: ${describe(error.cause)}`);
	process.exitCode = 1;
} finally {
	await client.end({ timeout: 5 });
}
