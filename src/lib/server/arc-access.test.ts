/** The per-request ARC access check against a stubbed PLANTdataHUB, with real Postgres for the stored
 *  (encrypted) logins and the refresh lock. No test touches the network. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { account } from '$lib/server/db/schema';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import { stubGitlab, type GitlabStub } from '$lib/server/test-support/gitlab-stub';
import { seedOidcLogin, seedUser } from '$lib/server/test-support/oidc-seed';
import {
	ACCESS_CACHE_TTL_MS,
	ACCESS_FAILURE_TTL_MS,
	accessFailure,
	checkArcAccess,
	loginStatus,
	resetArcAccessCache
} from './arc-access';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock(
	'$lib/server/env',
	async () => (await import('$lib/server/test-support/env-mock')).envModule
);

const ARC = 10;
const kind = async (userId: string, arcId = ARC) => (await checkArcAccess(userId, arcId)).kind;

describe.skipIf(!hasTestDb)('ARC access check (stubbed PLANTdataHUB, real Postgres)', () => {
	let t: DmlTestDb;
	let gitlab: GitlabStub;
	let errors: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(async () => {
		resetArcAccessCache();
		gitlab = stubGitlab();
		errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		// alice is a member of ARC 10, bob has a working login but no membership
		for (const [id, tok] of [
			['alice', 'tok-alice'],
			['bob', 'tok-bob']
		]) {
			gitlab.acceptToken(tok);
			await seedOidcLogin(t.db, id, { accessToken: tok });
		}
		gitlab.setProject(ARC, { visibility: 'private', members: ['tok-alice'] });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		errors.mockRestore();
	});

	describe('who can read', () => {
		it('a member reads a private ARC, a non-member is denied, and nobody is served by the other', async () => {
			expect(await kind('alice')).toBe('allow');
			expect(await kind('bob')).toBe('deny');
		});

		it('an internal ARC is readable by any user with a working login', async () => {
			gitlab.setProject(ARC, { visibility: 'internal' });
			expect(await kind('bob')).toBe('allow');
		});

		it('an unknown project is denied, like one the caller may not see', async () => {
			expect(await kind('alice', 999)).toBe('deny');
		});
	});

	describe('public ARCs are tried anonymously first', () => {
		beforeEach(() => gitlab.setProject(ARC, { visibility: 'public' }));

		it('are served with one anonymous call and no login at all', async () => {
			await seedUser(t.db, 'nologin');
			expect(await kind('nologin')).toBe('allow');
			expect(gitlab.projectCalls()).toEqual([{ id: ARC, token: undefined }]);
			expect(gitlab.refreshCalls()).toBe(0);
		});

		it('are served although the owner login is dead (refresh refused)', async () => {
			await seedOidcLogin(t.db, 'dead', { accessToken: 'tok-dead', expiresInMs: -60_000 });
			gitlab = stubGitlab({ singleUseFrom: 'not-the-stored-one' });
			gitlab.setProject(ARC, { visibility: 'public' });
			expect(await kind('dead')).toBe('allow');
			expect(gitlab.refreshCalls()).toBe(0);
		});

		it('a project that is not private for the caller falls through to their login', async () => {
			gitlab.setProject(ARC, { visibility: 'private', members: ['tok-alice'] });
			expect(await kind('alice')).toBe('allow');
			expect(gitlab.projectCalls().map((c) => c.token)).toEqual([undefined, 'tok-alice']);
		});
	});

	describe('revocation and visibility flips are caught within the TTL, not before', () => {
		beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));

		it('a revoked member is denied once the cached answer expires', async () => {
			vi.setSystemTime(new Date());
			expect(await kind('alice')).toBe('allow');
			gitlab.setProject(ARC, { visibility: 'private', members: [] }); // alice removed

			vi.setSystemTime(Date.now() + ACCESS_CACHE_TTL_MS - 1000);
			expect(await kind('alice')).toBe('allow'); // still believed, and no new call
			expect(gitlab.projectCalls()).toHaveLength(2);

			vi.setSystemTime(Date.now() + 2000);
			expect(await kind('alice')).toBe('deny');
		});

		it('a public ARC turned private is denied to a non-member after the TTL', async () => {
			gitlab.setProject(ARC, { visibility: 'public' });
			expect(await kind('bob')).toBe('allow');
			gitlab.setProject(ARC, { visibility: 'private', members: ['tok-alice'] });
			expect(await kind('bob')).toBe('allow');
			vi.setSystemTime(Date.now() + ACCESS_CACHE_TTL_MS + 1000);
			expect(await kind('bob')).toBe('deny');
		});

		it('a newly granted member gets in after the TTL', async () => {
			expect(await kind('bob')).toBe('deny');
			gitlab.setProject(ARC, { visibility: 'private', members: ['tok-bob'] });
			vi.setSystemTime(Date.now() + ACCESS_CACHE_TTL_MS + 1000);
			expect(await kind('bob')).toBe('allow');
		});
	});

	describe('the caller login cannot be used', () => {
		it('a user with no linked account is told to sign in, for an ARC that is not public', async () => {
			await seedUser(t.db, 'nologin');
			expect(await kind('nologin')).toBe('unusable-login');
		});

		it('a refresh token GitLab refuses is the same', async () => {
			await seedOidcLogin(t.db, 'dead', { accessToken: 'tok-dead', expiresInMs: -60_000 });
			gitlab = stubGitlab({ singleUseFrom: 'not-the-stored-one' });
			gitlab.setProject(ARC, { visibility: 'private', members: [] });
			expect(await kind('dead')).toBe('unusable-login');
		});

		it('an access token GitLab no longer accepts is the same', async () => {
			gitlab.rejectToken('tok-alice');
			expect(await kind('alice')).toBe('unusable-login');
		});
	});

	describe('PLANTdataHUB is not answering: fail closed', () => {
		it.each([500, 502, 503, 429, 302])(
			'status %s is "unavailable", never allow',
			async (status) => {
				gitlab.failProjects(status);
				expect(await kind('alice')).toBe('unavailable');
			}
		);

		it('a refused connection is unavailable', async () => {
			gitlab.failProjects('network');
			expect(await kind('alice')).toBe('unavailable');
		});

		it('a call that never answers is cut off by the timeout', async () => {
			gitlab.failProjects('hang');
			expect(await kind('alice')).toBe('unavailable');
		});

		it('a failure is remembered only for a few seconds, so a recovery shows at once', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date());
			gitlab.failProjects(503);
			const first = await checkArcAccess('alice', ARC);
			expect(first).toEqual({
				kind: 'unavailable',
				retryAfterSeconds: ACCESS_FAILURE_TTL_MS / 1000
			});
			const calls = gitlab.projectCalls().length;

			gitlab.failProjects(undefined);
			vi.setSystemTime(Date.now() + 2000);
			// a burst does not hammer GitLab: the remembered failure is returned, with the time left
			expect(await checkArcAccess('alice', ARC)).toEqual({
				kind: 'unavailable',
				retryAfterSeconds: 3
			});
			expect(gitlab.projectCalls()).toHaveLength(calls);

			vi.setSystemTime(Date.now() + ACCESS_FAILURE_TTL_MS);
			expect(await kind('alice')).toBe('allow');
			expect(ACCESS_FAILURE_TTL_MS).toBeLessThanOrEqual(10_000);
		});

		it('never logs a token', async () => {
			gitlab.failProjects(500);
			await kind('alice');
			gitlab.failProjects('network');
			resetArcAccessCache();
			await kind('alice');
			expect(JSON.stringify(errors.mock.calls)).not.toContain('tok-alice');
		});
	});

	describe('the cache', () => {
		it('is per user and ARC: one user answer never serves another', async () => {
			expect(await kind('alice')).toBe('allow');
			expect(await kind('bob')).toBe('deny');
			expect(await kind('alice')).toBe('allow');
			gitlab.setProject(11, { visibility: 'private', members: [] });
			expect(await kind('alice', 11)).toBe('deny');
			expect(await kind('alice')).toBe('allow');
		});

		it('shares one GitLab round trip between concurrent requests for the same user and ARC', async () => {
			const answers = await Promise.all(Array.from({ length: 20 }, () => kind('alice')));
			expect(new Set(answers)).toEqual(new Set(['allow']));
			// anonymous try + the login: exactly once each, not once per request
			expect(gitlab.projectCalls()).toHaveLength(2);
		});

		it('does not share a round trip between different users', async () => {
			await Promise.all([kind('alice'), kind('bob')]);
			expect(gitlab.projectCalls()).toHaveLength(4);
		});
	});

	describe('token refresh goes through the one lock-protected path', () => {
		it('a login whose access token expired is refreshed exactly once, however many checks need it', async () => {
			await seedOidcLogin(t.db, 'carol', { accessToken: 'tok-old', expiresInMs: -60_000 });
			gitlab = stubGitlab({ accessToken: 'glpat-fresh', delayMs: 200 });
			gitlab.setProject(ARC, { visibility: 'private', members: ['glpat-fresh'] });
			gitlab.setProject(11, { visibility: 'private', members: ['glpat-fresh'] });
			gitlab.setProject(12, { visibility: 'private', members: ['glpat-fresh'] });

			const answers = await Promise.all([ARC, 11, 12].map((arc) => kind('carol', arc)));
			expect(answers).toEqual(['allow', 'allow', 'allow']);
			expect(gitlab.refreshCalls()).toBe(1);
			// the refreshed token, not the expired one, is what reached the project API
			expect(
				gitlab
					.projectCalls()
					.filter((c) => c.token)
					.every((c) => c.token === 'glpat-fresh')
			).toBe(true);
			// and it was stored: no refresh for the next ARC either
			gitlab.setProject(13, { visibility: 'internal' });
			expect(await kind('carol', 13)).toBe('allow');
			expect(gitlab.refreshCalls()).toBe(1);
		});
	});

	describe('loginStatus (for /account/tokens)', () => {
		it('is ok for a working login, sign-in-again for a missing or dead one', async () => {
			expect(await loginStatus('alice')).toBe('ok');
			await seedUser(t.db, 'nologin');
			expect(await loginStatus('nologin')).toBe('sign-in-again');
			await t.db
				.update(account)
				.set({ accessTokenExpiresAt: new Date(0) })
				.where(eq(account.userId, 'bob'));
			gitlab = stubGitlab({ singleUseFrom: 'not-the-stored-one' });
			expect(await loginStatus('bob')).toBe('sign-in-again');
		});
	});
});

describe('accessFailure: the one mapping to HTTP', () => {
	it('allow is no failure; deny is a 404; a dead login is a 403; PLANTdataHUB trouble is a 503 with Retry-After', () => {
		expect(accessFailure({ kind: 'allow' })).toBeUndefined();
		expect(accessFailure({ kind: 'deny' })).toEqual({ status: 404 });
		const unusable = accessFailure({ kind: 'unusable-login' });
		expect(unusable?.status).toBe(403);
		expect(unusable?.message).toMatch(/sign in to MIRA again/i);
		expect(accessFailure({ kind: 'unavailable', retryAfterSeconds: 7 })).toMatchObject({
			status: 503,
			retryAfterSeconds: 7
		});
	});
});

placeholderWithoutDb('ARC access check');
