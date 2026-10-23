import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, ne } from 'drizzle-orm';
import { betterAuth } from 'better-auth/minimal';
import { symmetricEncrypt } from 'better-auth/crypto';
import { account, user } from '$lib/server/db/schema';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import { stubGitlab, type GitlabStub } from '$lib/server/test-support/gitlab-stub';
import { baseAuthOptions, sharedPlugins } from '$lib/server/auth-options';
import { getWorkerAccessToken } from '$lib/server/etl/worker-auth';
import { isTransient, TokenError } from '$lib/server/etl/errors';
import { refreshLockName, RefreshLockTimeoutError, withRefreshLock } from './token-refresh-lock';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock('$lib/server/env', () => ({
	config: {
		origin: 'https://mira.test',
		authSecret: 'x'.repeat(40),
		adminEmails: [],
		// two connections in the pool: the lock may be held by one caller at a time (poolMax / 2)
		db: { poolMax: 2 },
		http: { headersTimeoutSeconds: 5, totalTimeoutSeconds: 10 },
		oidc: {
			issuerUrl: 'https://gitlab.test',
			clientId: 'client',
			clientSecret: 'secret',
			scopes: ['openid', 'profile', 'email', 'read_api']
		}
	}
}));

const SECRET = 'x'.repeat(40);
const OLD_REFRESH = 'glrt-initial';

describe.skipIf(!hasTestDb)('refresh of a user token is serialised (decision 3)', () => {
	let t: DmlTestDb;
	let gitlab: GitlabStub;

	/** a user whose access token expired a minute ago, with a refresh token GitLab still accepts */
	async function seedExpired(id: string) {
		await t.db.insert(user).values({ id, name: id, email: `${id}@example.org` });
		await t.db.insert(account).values({
			id: `acc-${id}`,
			accountId: `gl-${id}`,
			providerId: 'oidc',
			userId: id,
			accessToken: await symmetricEncrypt({ key: SECRET, data: 'glpat-old' }),
			refreshToken: await symmetricEncrypt({ key: SECRET, data: OLD_REFRESH }),
			accessTokenExpiresAt: new Date(Date.now() - 60_000)
		});
	}

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(async () => {
		gitlab = stubGitlab({
			accessToken: 'glpat-fresh',
			refreshToken: 'glrt-next',
			singleUseFrom: OLD_REFRESH,
			delayMs: 300
		});
		await t.db.delete(account);
		await t.db.delete(user).where(ne(user.id, t.userId));
	});
	afterEach(() => vi.unstubAllGlobals());

	it('without the lock, two concurrent refreshes race and one loses (why the lock exists)', async () => {
		await seedExpired('u1');
		const raw = betterAuth({ ...baseAuthOptions, secret: SECRET, plugins: sharedPlugins() });
		const call = () =>
			raw.api.getAccessToken({ body: { providerId: 'oidc', accountId: 'gl-u1', userId: 'u1' } });
		const results = await Promise.allSettled([call(), call()]);
		expect(gitlab.refreshCalls()).toBe(2);
		expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
	});

	it('with the lock, two concurrent worker refreshes make exactly one refresh call', async () => {
		await seedExpired('u1');
		const [a, b] = await Promise.all([getWorkerAccessToken('u1'), getWorkerAccessToken('u1')]);
		expect(a).toBe('glpat-fresh');
		expect(b).toBe('glpat-fresh');
		expect(gitlab.refreshCalls()).toBe(1);
		// a later call finds the stored token valid and does not refresh again
		expect(await getWorkerAccessToken('u1')).toBe('glpat-fresh');
		expect(gitlab.refreshCalls()).toBe(1);
	});

	it('serialises many callers and several users when the pool allows one lock at a time', async () => {
		// each user has their own refresh token at GitLab; the stub here accepts any
		gitlab = stubGitlab({ accessToken: 'glpat-fresh', refreshToken: 'glrt-next', delayMs: 300 });
		for (const id of ['u1', 'u2', 'u3']) await seedExpired(id);
		const ids = ['u1', 'u2', 'u3'];
		const tokens = await Promise.all(ids.flatMap((id) => [id, id, id].map(getWorkerAccessToken)));
		expect(tokens.every((tok) => tok === 'glpat-fresh')).toBe(true);
		expect(gitlab.refreshCalls()).toBe(3); // one per user, not one per caller
	});

	it('takes no lock and makes no refresh while the stored token is valid', async () => {
		await seedExpired('u1');
		await t.db
			.update(account)
			.set({ accessTokenExpiresAt: new Date(Date.now() + 3_600_000) })
			.where(eq(account.userId, 'u1'));
		// a held lock would block a caller that needs it; this one must not need it
		const holder = holdLock('u1');
		await holder.ready;
		expect(await getWorkerAccessToken('u1')).toBe('glpat-old');
		expect(gitlab.refreshCalls()).toBe(0);
		holder.release();
		await holder.done;
	});

	it('gives up after the bounded wait with a transient error, without calling the refresh', async () => {
		await seedExpired('u1');
		const holder = holdLock('u1');
		await holder.ready;
		const getToken = vi.fn(async () => 'never');
		const err = await withRefreshLock('u1', 'gl-u1', getToken, 200).catch((e) => e);
		expect(err).toBeInstanceOf(RefreshLockTimeoutError);
		expect(isTransient(err)).toBe(true);
		expect(getToken).not.toHaveBeenCalled();
		holder.release();
		await holder.done;
	});

	it('reports a revoked refresh token as "sign in again" and keeps the lock usable', async () => {
		await seedExpired('u1');
		gitlab = stubGitlab({ accessToken: 'x', refreshToken: 'y', singleUseFrom: 'something-else' });
		await expect(getWorkerAccessToken('u1')).rejects.toBeInstanceOf(TokenError);
		await expect(getWorkerAccessToken('u1')).rejects.toBeInstanceOf(TokenError); // no leaked lock
	});

	/** another connection holding the user's lock, as a refresh in another process would */
	function holdLock(userId: string) {
		let release!: () => void;
		let ready!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const readyP = new Promise<void>((r) => (ready = r));
		const done = t.client.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(hashtextextended(${refreshLockName(userId)}, 0))`;
			ready();
			await gate;
		});
		return { ready: readyP, release, done };
	}
});

placeholderWithoutDb('token refresh lock');
