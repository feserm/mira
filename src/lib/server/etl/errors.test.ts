import { error } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { FetchTimeoutError } from '$lib/server/fetch-timeout';
import { TokenError, errorMessage, isTransient } from './errors';

const httpError = (status: number) => {
	try {
		error(status as 404, 'x');
	} catch (e) {
		return e;
	}
};

describe('isTransient', () => {
	it.each([
		['a fetch timeout', new FetchTimeoutError('headers', 1000, 'git.example.org')],
		['PLANTdataHUB 502', httpError(502)],
		['PLANTdataHUB 503', httpError(503)],
		['a refused connection', Object.assign(new Error('x'), { code: 'ECONNREFUSED' })],
		['a wrapped connection reset', new Error('q', { cause: { code: 'ECONNRESET' } })],
		['undici "fetch failed"', new TypeError('fetch failed')],
		['a Postgres deadlock', Object.assign(new Error('x'), { code: '40P01' })],
		['a Postgres connection failure', Object.assign(new Error('x'), { code: '08006' })],
		['a postgres.js connect timeout', Object.assign(new Error('x'), { code: 'CONNECT_TIMEOUT' })]
	])('retries %s', (_name, e) => {
		expect(isTransient(e)).toBe(true);
	});

	it.each([
		['401', httpError(401)],
		['403', httpError(403)],
		['404', httpError(404)],
		['500 (our own bug)', httpError(500)],
		['a missing or revoked token', new TokenError('sign in again')],
		['an RO-Crate parse error', new SyntaxError('Unexpected token')],
		['a unique violation', Object.assign(new Error('x'), { code: '23505' })],
		['a non-error value', 'boom']
	])('does not retry %s', (_name, e) => {
		expect(isTransient(e)).toBe(false);
	});
});

describe('errorMessage', () => {
	it('uses the body message of an HTTP error and the message of an Error', () => {
		expect(errorMessage(httpError(404))).toBe('x');
		expect(errorMessage(new Error('plain'))).toBe('plain');
		expect(errorMessage('str')).toBe('str');
	});
});
