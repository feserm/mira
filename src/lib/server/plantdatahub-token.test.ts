import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, type RequestEvent } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';

const { getAccessTokenApi, withRefreshLock } = vi.hoisted(() => ({
	getAccessTokenApi: vi.fn(),
	withRefreshLock: vi.fn(async (_u: string, _a: string, fn: () => Promise<unknown>) => fn())
}));

vi.mock('$lib/server/auth', () => ({ auth: { api: { getAccessToken: getAccessTokenApi } } }));
vi.mock('$lib/server/oidc-account', () => ({ findOidcAccountId: async () => 'gl-1' }));
vi.mock('$lib/server/token-refresh-lock', async () => ({
	...(await vi.importActual<typeof import('./token-refresh-lock')>('./token-refresh-lock')),
	withRefreshLock
}));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/env', () => ({ config: { db: { poolMax: 10 }, http: {} } }));

import { getAccessToken } from './plantdatahub-token';
import { RefreshLockTimeoutError } from './token-refresh-lock';

const event = (userId?: string) =>
	({
		locals: userId ? { user: { id: userId } } : {},
		request: new Request('http://x/')
	}) as unknown as RequestEvent;

async function statusOf(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (e) {
		return isHttpError(e) ? e.status : e;
	}
}

describe('getAccessToken (web)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns the token and takes the per-user refresh lock', async () => {
		getAccessTokenApi.mockResolvedValue({ accessToken: 'tok' });
		expect(await getAccessToken(event('u1'))).toBe('tok');
		expect(withRefreshLock).toHaveBeenCalledWith('u1', 'gl-1', expect.any(Function));
	});

	it('answers 401 when nobody is signed in', async () => {
		expect(await statusOf(getAccessToken(event()))).toBe(401);
	});

	it('answers 401 "log in again" when better-auth cannot give a token (e.g. after a secret rotation)', async () => {
		getAccessTokenApi.mockRejectedValue(new APIError('BAD_REQUEST', { message: 'Failed' }));
		expect(await statusOf(getAccessToken(event('u1')))).toBe(401);
		getAccessTokenApi.mockResolvedValue({ accessToken: '' });
		expect(await statusOf(getAccessToken(event('u1')))).toBe(401);
	});

	it('answers 503 when the lock wait timed out', async () => {
		withRefreshLock.mockRejectedValueOnce(new RefreshLockTimeoutError());
		expect(await statusOf(getAccessToken(event('u1')))).toBe(503);
	});

	it('does not hide other errors', async () => {
		getAccessTokenApi.mockRejectedValue(new Error('database down'));
		expect(await statusOf(getAccessToken(event('u1')))).toBeInstanceOf(Error);
	});
});
