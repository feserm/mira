/** Pure validation of the server's environment, kept separate from `env.ts` so it can be unit
 *  tested without SvelteKit's `$env` modules. Error messages name the variable and the rule that
 *  failed, but never echo a value -- several of these are secrets. */

export type DbSsl = 'require' | 'allow' | 'prefer' | 'verify-full';

export interface ServerConfig {
	databaseUrl: string;
	origin: string;
	authSecret: string;
	/** Lower-cased e-mail addresses made admin on sign-in (`ADMIN_EMAILS`). Empty: nobody is admin. */
	adminEmails: string[];
	oidc: {
		issuerUrl: string;
		clientId: string;
		clientSecret?: string;
		scopes: string[];
	};
	db: {
		poolMax: number;
		idleTimeoutSeconds?: number;
		connectTimeoutSeconds?: number;
		ssl?: DbSsl;
		/** Named prepared statements (postgres.js default). Off only behind a pooler that cannot track them. */
		prepare: boolean;
	};
	/** Timeouts for every outbound HTTP call (PLANTdataHUB). */
	http: {
		headersTimeoutSeconds: number;
		totalTimeoutSeconds: number;
	};
	/** Background ETL worker (see docs/etl-worker.md). The web app only reads `maxAttempts`. */
	etl: {
		concurrency: number;
		leaseSeconds: number;
		pollSeconds: number;
		maxAttempts: number;
		retryDelaySeconds: number;
		shutdownTimeoutSeconds: number;
	};
}

export interface EnvValidation {
	/** Best-effort config. Only safe to use when `errors` is empty. */
	config: ServerConfig;
	errors: string[];
}

type RawEnv = Record<string, string | undefined>;

const MIN_SECRET_LENGTH = 32;
const DEFAULT_POOL_MAX = 10;
const DEFAULT_SCOPES = 'openid profile email';
const SSL_MODES: readonly DbSsl[] = ['require', 'allow', 'prefer', 'verify-full'];

function parseUrl(value: string): URL | undefined {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

export function validateEnv(raw: RawEnv): EnvValidation {
	const errors: string[] = [];
	const get = (name: string): string => raw[name]?.trim() ?? '';

	const required = (name: string): string => {
		const value = get(name);
		if (!value) errors.push(`${name} is required but not set`);
		return value;
	};

	const databaseUrl = required('DATABASE_URL');
	if (databaseUrl) {
		const url = parseUrl(databaseUrl);
		if (!url || !['postgres:', 'postgresql:'].includes(url.protocol)) {
			errors.push('DATABASE_URL must be a postgres:// or postgresql:// URL');
		}
	}

	const origin = required('ORIGIN');
	if (origin) {
		const url = parseUrl(origin);
		const nodeEnv = get('NODE_ENV');
		const relaxed = nodeEnv === 'development' || nodeEnv === 'test';
		if (!url || !['http:', 'https:'].includes(url.protocol)) {
			errors.push('ORIGIN must be a valid http(s) URL such as https://mira.example.org');
		} else if (url.pathname !== '/' || url.search || url.hash || origin.endsWith('/')) {
			errors.push('ORIGIN must be only scheme, host and port, with no path or trailing slash');
		} else if (url.protocol !== 'https:' && !relaxed) {
			errors.push('ORIGIN must use https unless NODE_ENV is development or test');
		}
	}

	const authSecret = required('BETTER_AUTH_SECRET');
	if (authSecret && authSecret.length < MIN_SECRET_LENGTH) {
		errors.push(`BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
	}

	const adminEmails = get('ADMIN_EMAILS')
		.split(',')
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	if (adminEmails.some((e) => !/^[^\s@]+@[^\s@]+$/.test(e))) {
		errors.push('ADMIN_EMAILS must be a comma separated list of e-mail addresses');
	}

	const issuerUrl = required('OIDC_ISSUER_URL');
	if (issuerUrl) {
		if (!parseUrl(issuerUrl)) {
			errors.push('OIDC_ISSUER_URL must be a valid URL');
		} else if (issuerUrl.endsWith('/')) {
			errors.push('OIDC_ISSUER_URL must not have a trailing slash');
		} else if (issuerUrl.includes('/.well-known')) {
			errors.push('OIDC_ISSUER_URL must be the base issuer, without the /.well-known suffix');
		}
	}

	const clientId = required('OIDC_CLIENT_ID');

	const integer = (name: string, min: number): number | undefined => {
		const value = get(name);
		if (!value) return undefined;
		const parsed = Number(value);
		if (!Number.isInteger(parsed) || parsed < min) {
			errors.push(`${name} must be an integer >= ${min}`);
			return undefined;
		}
		return parsed;
	};

	const poolMax = integer('DB_POOL_MAX', 1) ?? DEFAULT_POOL_MAX;
	const idleTimeoutSeconds = integer('DB_IDLE_TIMEOUT', 0);
	const connectTimeoutSeconds = integer('DB_CONNECT_TIMEOUT', 1);

	let ssl: DbSsl | undefined;
	const sslRaw = get('DB_SSL').toLowerCase();
	if (sslRaw === 'true') {
		ssl = 'require';
	} else if (sslRaw && sslRaw !== 'false') {
		if ((SSL_MODES as readonly string[]).includes(sslRaw)) {
			ssl = sslRaw as DbSsl;
		} else {
			errors.push(`DB_SSL must be one of: ${SSL_MODES.join(', ')}, true, false`);
		}
	}

	let prepare = true;
	const prepareRaw = get('DB_PREPARE').toLowerCase();
	if (prepareRaw === 'false') {
		prepare = false;
	} else if (prepareRaw && prepareRaw !== 'true') {
		errors.push('DB_PREPARE must be true or false');
	}

	const headersTimeoutSeconds = integer('HTTP_HEADERS_TIMEOUT', 1) ?? 30;
	const totalTimeoutSeconds = integer('HTTP_TIMEOUT', 1) ?? 300;
	if (headersTimeoutSeconds > totalTimeoutSeconds) {
		errors.push('HTTP_HEADERS_TIMEOUT must not be larger than HTTP_TIMEOUT');
	}

	const leaseSeconds = integer('ETL_LEASE_SECONDS', 10) ?? 60;

	return {
		errors,
		config: {
			databaseUrl,
			origin,
			authSecret,
			adminEmails,
			oidc: {
				issuerUrl,
				clientId,
				clientSecret: get('OIDC_CLIENT_SECRET') || undefined,
				scopes: (get('OIDC_SCOPES') || DEFAULT_SCOPES).split(/\s+/)
			},
			db: { poolMax, idleTimeoutSeconds, connectTimeoutSeconds, ssl, prepare },
			http: { headersTimeoutSeconds, totalTimeoutSeconds },
			etl: {
				concurrency: integer('ETL_CONCURRENCY', 1) ?? 1,
				leaseSeconds,
				pollSeconds: integer('ETL_POLL_SECONDS', 1) ?? 5,
				maxAttempts: integer('ETL_MAX_ATTEMPTS', 1) ?? 3,
				retryDelaySeconds: integer('ETL_RETRY_DELAY_SECONDS', 0) ?? 30,
				shutdownTimeoutSeconds: integer('ETL_SHUTDOWN_TIMEOUT', 0) ?? 60
			}
		}
	};
}

export function formatEnvErrors(errors: string[]): string {
	return `Invalid server configuration (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n${errors
		.map((e) => `  - ${e}`)
		.join('\n')}`;
}
