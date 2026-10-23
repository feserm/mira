import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth/minimal';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { account } from '$lib/server/db/schema';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import { baseAuthOptions, sharedPlugins } from '$lib/server/auth-options';
import { stubGitlab, type GitlabStub } from '$lib/server/test-support/gitlab-stub';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock('$lib/server/env', () => ({
	config: {
		origin: 'https://mira.test',
		authSecret: 'x'.repeat(40),
		adminEmails: [],
		oidc: {
			issuerUrl: 'https://gitlab.test',
			clientId: 'client',
			clientSecret: 'secret',
			scopes: ['openid', 'profile', 'email', 'read_api']
		}
	}
}));

const SECRET = 'x'.repeat(40);
const instance = (secret = SECRET) =>
	betterAuth({ ...baseAuthOptions, secret, plugins: sharedPlugins() });

describe.skipIf(!hasTestDb)('OAuth tokens are encrypted at rest (S2.3)', () => {
	let t: DmlTestDb;
	let gitlab: GitlabStub;
	const secretText = { access: 'glpat-access-NEW', refresh: 'glrt-refresh-NEW' };

	const stored = async () =>
		(await t.db.select().from(account).where(eq(account.userId, t.userId)))[0];

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(async () => {
		gitlab = stubGitlab({ accessToken: secretText.access, refreshToken: secretText.refresh });
		await t.db.delete(account);
		await t.db.insert(account).values({
			id: 'acc-1',
			accountId: 'gl-1',
			providerId: 'oidc',
			userId: t.userId,
			accessToken: await symmetricEncrypt({ key: SECRET, data: 'glpat-access-OLD' }),
			refreshToken: await symmetricEncrypt({ key: SECRET, data: 'glrt-refresh-OLD' }),
			accessTokenExpiresAt: new Date(Date.now() - 60_000)
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('stores a refreshed token encrypted, and hands the plaintext to the caller', async () => {
		const tokens = await instance().api.getAccessToken({
			body: { providerId: 'oidc', accountId: 'gl-1', userId: t.userId }
		});
		expect(tokens.accessToken).toBe(secretText.access);
		expect(gitlab.refreshCalls()).toBe(1);

		const row = await stored();
		expect(row.accessToken).not.toBeNull();
		expect(row.accessToken).not.toBe(secretText.access);
		expect(row.accessToken).not.toContain(secretText.access);
		expect(row.refreshToken).not.toBe(secretText.refresh);
		expect(row.refreshToken).not.toContain(secretText.refresh);
		expect(await symmetricDecrypt({ key: SECRET, data: row.accessToken! })).toBe(secretText.access);
		expect(await symmetricDecrypt({ key: SECRET, data: row.refreshToken! })).toBe(
			secretText.refresh
		);
	});

	it('cannot read tokens stored under another BETTER_AUTH_SECRET (rotation)', async () => {
		await expect(
			instance('y'.repeat(40)).api.getAccessToken({
				body: { providerId: 'oidc', accountId: 'gl-1', userId: t.userId }
			})
		).rejects.toThrow();
		expect(gitlab.refreshCalls()).toBe(0);
	});

	it('has a migration that clears plaintext tokens of existing rows', async () => {
		await t.db
			.update(account)
			.set({ accessToken: 'plaintext-access', refreshToken: 'plaintext-refresh', idToken: 'jwt' })
			.where(eq(account.userId, t.userId));
		await t.client.unsafe(readFileSync('drizzle/0005_null_stored_oauth_tokens.sql', 'utf8'));
		const row = await stored();
		expect([row.accessToken, row.refreshToken, row.idToken]).toEqual([null, null, null]);
		expect(row.accountId).toBe('gl-1'); // the link itself stays
	});

	it('gives no token for a row whose tokens were cleared by the migration', async () => {
		await t.db
			.update(account)
			.set({ accessToken: null, refreshToken: null, idToken: null })
			.where(eq(account.userId, t.userId));
		const tokens = await instance().api.getAccessToken({
			body: { providerId: 'oidc', accountId: 'gl-1', userId: t.userId }
		});
		expect(tokens.accessToken).toBeFalsy();
		expect(gitlab.refreshCalls()).toBe(0);
	});
});

placeholderWithoutDb('token encryption');
