import { describe, expect, it } from 'vitest';
import { formatEnvErrors, validateEnv } from './env-schema';

const valid = {
	DATABASE_URL: 'postgres://u:p@localhost:5432/db',
	ORIGIN: 'https://mira.example.org',
	BETTER_AUTH_SECRET: 'x'.repeat(32),
	OIDC_ISSUER_URL: 'https://git.example.org',
	OIDC_CLIENT_ID: 'client'
};

describe('validateEnv', () => {
	it('accepts a minimal valid environment and applies defaults', () => {
		const { config, errors } = validateEnv(valid);
		expect(errors).toEqual([]);
		expect(config.db.poolMax).toBe(10);
		expect(config.db.ssl).toBeUndefined();
		expect(config.oidc.clientSecret).toBeUndefined();
		expect(config.oidc.scopes).toEqual(['openid', 'profile', 'email']);
	});

	it('parses optional settings', () => {
		const { config, errors } = validateEnv({
			...valid,
			OIDC_CLIENT_SECRET: 's',
			OIDC_SCOPES: 'openid  read_api',
			DB_POOL_MAX: '4',
			DB_IDLE_TIMEOUT: '30',
			DB_CONNECT_TIMEOUT: '5',
			DB_SSL: 'verify-full'
		});
		expect(errors).toEqual([]);
		expect(config.oidc.scopes).toEqual(['openid', 'read_api']);
		expect(config.db).toEqual({
			poolMax: 4,
			idleTimeoutSeconds: 30,
			connectTimeoutSeconds: 5,
			ssl: 'verify-full'
		});
	});

	it('defaults the timeouts and the ETL worker settings', () => {
		const { config, errors } = validateEnv(valid);
		expect(errors).toEqual([]);
		expect(config.http).toEqual({ headersTimeoutSeconds: 30, totalTimeoutSeconds: 300 });
		expect(config.etl).toEqual({
			concurrency: 1,
			leaseSeconds: 60,
			pollSeconds: 5,
			maxAttempts: 3,
			retryDelaySeconds: 30,
			shutdownTimeoutSeconds: 60
		});
	});

	it('parses the timeout and ETL worker settings', () => {
		const { config, errors } = validateEnv({
			...valid,
			HTTP_HEADERS_TIMEOUT: '5',
			HTTP_TIMEOUT: '20',
			ETL_CONCURRENCY: '3',
			ETL_LEASE_SECONDS: '30',
			ETL_POLL_SECONDS: '2',
			ETL_MAX_ATTEMPTS: '1',
			ETL_RETRY_DELAY_SECONDS: '0',
			ETL_SHUTDOWN_TIMEOUT: '10'
		});
		expect(errors).toEqual([]);
		expect(config.http).toEqual({ headersTimeoutSeconds: 5, totalTimeoutSeconds: 20 });
		expect(config.etl.concurrency).toBe(3);
		expect(config.etl.leaseSeconds).toBe(30);
		expect(config.etl.retryDelaySeconds).toBe(0);
	});

	it('rejects bad timeout and ETL worker settings, naming the variable', () => {
		const { errors } = validateEnv({
			...valid,
			HTTP_HEADERS_TIMEOUT: '60',
			HTTP_TIMEOUT: '10',
			ETL_CONCURRENCY: '0',
			ETL_LEASE_SECONDS: '5',
			ETL_MAX_ATTEMPTS: 'many'
		});
		for (const name of [
			'HTTP_HEADERS_TIMEOUT',
			'ETL_CONCURRENCY',
			'ETL_LEASE_SECONDS',
			'ETL_MAX_ATTEMPTS'
		]) {
			expect(errors.some((e) => e.startsWith(name))).toBe(true);
		}
	});

	it('maps DB_SSL=true to require and false to off', () => {
		expect(validateEnv({ ...valid, DB_SSL: 'true' }).config.db.ssl).toBe('require');
		expect(validateEnv({ ...valid, DB_SSL: 'false' }).config.db.ssl).toBeUndefined();
	});

	it('reports every missing required variable at once', () => {
		const { errors } = validateEnv({});
		expect(errors).toHaveLength(5);
		for (const name of [
			'DATABASE_URL',
			'ORIGIN',
			'BETTER_AUTH_SECRET',
			'OIDC_ISSUER_URL',
			'OIDC_CLIENT_ID'
		]) {
			expect(errors.some((e) => e.startsWith(name))).toBe(true);
		}
	});

	it('rejects a short secret without echoing it', () => {
		const secret = 'short-secret-value';
		const { errors } = validateEnv({ ...valid, BETTER_AUTH_SECRET: secret });
		expect(errors).toHaveLength(1);
		expect(formatEnvErrors(errors)).not.toContain(secret);
	});

	it('requires https ORIGIN outside development/test', () => {
		const http = { ...valid, ORIGIN: 'http://mira.example.org' };
		expect(validateEnv(http).errors).toHaveLength(1);
		expect(validateEnv({ ...http, NODE_ENV: 'production' }).errors).toHaveLength(1);
		expect(validateEnv({ ...http, NODE_ENV: 'development' }).errors).toEqual([]);
		expect(validateEnv({ ...http, NODE_ENV: 'test' }).errors).toEqual([]);
	});

	it('rejects malformed ORIGIN values', () => {
		expect(validateEnv({ ...valid, ORIGIN: 'not a url' }).errors).toHaveLength(1);
		expect(validateEnv({ ...valid, ORIGIN: 'https://mira.example.org/' }).errors).toHaveLength(1);
		expect(validateEnv({ ...valid, ORIGIN: 'https://mira.example.org/app' }).errors).toHaveLength(
			1
		);
	});

	it('rejects malformed OIDC_ISSUER_URL values', () => {
		for (const OIDC_ISSUER_URL of [
			'nope',
			'https://git.example.org/',
			'https://git.example.org/.well-known/openid-configuration'
		]) {
			expect(validateEnv({ ...valid, OIDC_ISSUER_URL }).errors).toHaveLength(1);
		}
	});

	it('rejects a non-postgres DATABASE_URL and bad numeric/ssl settings', () => {
		const { errors } = validateEnv({
			...valid,
			DATABASE_URL: 'mysql://localhost/db',
			DB_POOL_MAX: '0',
			DB_IDLE_TIMEOUT: 'abc',
			DB_CONNECT_TIMEOUT: '1.5',
			DB_SSL: 'maybe'
		});
		expect(errors).toHaveLength(5);
	});
});
