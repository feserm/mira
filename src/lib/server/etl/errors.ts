import { isHttpError } from '@sveltejs/kit';
import { FetchTimeoutError } from '$lib/server/fetch-timeout';

/** The importing user's PLANTdataHUB token could not be obtained. Never retried: sign in again. */
export class TokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TokenError';
	}
}

export function errorMessage(e: unknown): string {
	if (isHttpError(e)) return e.body.message;
	return e instanceof Error ? e.message : String(e);
}

// Node/undici/postgres.js network error codes that mean "try again later".
const TRANSIENT_CODES = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'ENOTFOUND',
	'EPIPE',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET',
	'CONNECT_TIMEOUT',
	'CONNECTION_CLOSED',
	'CONNECTION_ENDED',
	'CONNECTION_DESTROYED',
	// Postgres: serialization failure, deadlock detected, admin shutdown / crash, connection class
	'40001',
	'40P01',
	'57P01',
	'57P03'
]);

/** Whether retrying the same job later could succeed. Network failures, our fetch timeouts, 429/5xx
 *  from PLANTdataHUB and transient database errors are transient; everything else (401/403/404, an
 *  unparsable RO-Crate, a missing token, a bug) is deterministic and fails at once. */
export function isTransient(e: unknown): boolean {
	for (let err = e, depth = 0; err && depth < 5; depth++) {
		if (err instanceof TokenError) return false;
		if (err instanceof FetchTimeoutError) return true;
		if (isHttpError(err)) return [429, 502, 503, 504].includes(err.status);
		if (typeof err === 'object') {
			const { code, name, message } = err as { code?: unknown; name?: unknown; message?: unknown };
			if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) {
				return true;
			}
			// undici reports a refused/reset connection as TypeError("fetch failed") with the cause attached
			if (name === 'TypeError' && message === 'fetch failed' && !(err as Error).cause) return true;
			err = (err as { cause?: unknown }).cause;
		} else {
			return false;
		}
	}
	return false;
}
