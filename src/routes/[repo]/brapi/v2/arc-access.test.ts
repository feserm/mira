/** Per-ARC access control (S2.4b) on every BrAPI handler, through the real `+server.ts` files against
 *  Postgres (DML-only role) and a stubbed PLANTdataHUB. The handler list comes from the file system,
 *  so a new endpoint that skips `resolveReadableArc` fails here without anyone remembering to add it. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiToken } from '$lib/server/api-token';
import { resetArcAccessCache } from '$lib/server/arc-access';
import { ARC_IDS, REPOS, seedBrapiFixture } from '$lib/server/test-support/brapi-fixture';
import {
	anonymousLocals,
	authenticatedLocals,
	bearer,
	callBrapi,
	type BrapiHandler,
	type BrapiResult
} from '$lib/server/test-support/brapi-event';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import { stubGitlab, type GitlabStub } from '$lib/server/test-support/gitlab-stub';
import { seedOidcLogin, seedUser } from '$lib/server/test-support/oidc-seed';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock(
	'$lib/server/env',
	async () => (await import('$lib/server/test-support/env-mock')).envModule
);

const modules = import.meta.glob<{ GET: BrapiHandler }>('./**/+server.ts', { eager: true });
const HANDLERS = Object.entries(modules).map(([file, m]) => [file, m.GET] as const);
const PARAMS = { germplasmDbId: '00000000-0000-4000-8000-000000000000' };

describe('every BrAPI handler is found', () => {
	it('lists the handlers from the file system (a new endpoint is picked up automatically)', () => {
		expect(HANDLERS.length).toBeGreaterThanOrEqual(7);
		for (const [, handler] of HANDLERS) expect(typeof handler).toBe('function');
	});
});

describe.skipIf(!hasTestDb)('BrAPI per-ARC access (stubbed PLANTdataHUB, real Postgres)', () => {
	let t: DmlTestDb;
	let gitlab: GitlabStub;
	let aliceToken: string;
	let bobToken: string;
	let errors: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
		stubGitlab({ unknownProjects: 'public' }); // the seed runs Transform, which asks NCBI
		await seedBrapiFixture(t);
		vi.unstubAllGlobals();
		for (const [id, tok] of [
			['alice', 'tok-alice'],
			['bob', 'tok-bob']
		]) {
			await seedOidcLogin(t.db, id, { accessToken: tok });
		}
		await seedUser(t.db, 'nologin');
		aliceToken = (await createApiToken('alice', 'a', 30)).token;
		bobToken = (await createApiToken('bob', 'b', 30)).token;
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(() => {
		resetArcAccessCache();
		errors = vi.spyOn(console, 'log').mockImplementation(() => {});
		gitlab = stubGitlab();
		gitlab.acceptToken('tok-alice');
		gitlab.acceptToken('tok-bob');
		// alpha is private with alice as a member; beta is private with nobody in it; gamma is public
		gitlab.setProject(ARC_IDS.alpha, { visibility: 'private', members: ['tok-alice'] });
		gitlab.setProject(ARC_IDS.beta, { visibility: 'private', members: [] });
		gitlab.setProject(ARC_IDS.gamma, { visibility: 'public' });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		errors.mockRestore();
	});

	const call = (
		handler: BrapiHandler,
		repo: string,
		who: 'alice' | 'bob' | 'nologin',
		via: 'session' | 'token'
	) =>
		callBrapi(handler, {
			repo,
			params: PARAMS,
			...(via === 'session'
				? { locals: authenticatedLocals(who) }
				: { locals: anonymousLocals(), headers: bearer(who === 'alice' ? aliceToken : bobToken) })
		});

	/** what a client sees for a repo that does not exist, with the repo name swapped in */
	async function asUnknown(handler: BrapiHandler, repo: string, via: 'session' | 'token') {
		const res = await call(handler, 'No/Such-Arc', 'bob', via);
		return JSON.parse(JSON.stringify(res).replaceAll('No/Such-Arc', repo)) as BrapiResult;
	}

	describe.each(HANDLERS)('%s', (_file, handler) => {
		it.each(['session', 'token'] as const)(
			'refuses a %s caller who cannot read the ARC with the answer for an unknown repo',
			async (via) => {
				const denied = await call(handler, REPOS.alpha, 'bob', via);
				expect(denied.status).toBe(404);
				expect(denied.body).not.toHaveProperty('result');
				const unknown = await asUnknown(handler, REPOS.alpha, via);
				expect({ ...denied, locals: undefined }).toEqual({ ...unknown, locals: undefined });
			}
		);

		it('refuses a caller who cannot read a private ARC nobody is a member of, a member of another', async () => {
			expect((await call(handler, REPOS.beta, 'alice', 'session')).status).toBe(404);
		});

		it('serves a public ARC to a caller with no PLANTdataHUB login at all, anonymously asked', async () => {
			const res = await call(handler, REPOS.gamma, 'nologin', 'session');
			// (the mcpd route answers 404 "Unknown germplasmDbId" here: the ARC itself was served)
			expect(res.body.message ?? '').not.toContain('Unknown ARC');
			expect(res.status).not.toBe(403);
			expect(res.status).not.toBe(503);
			expect(gitlab.projectCalls().every((c) => c.token === undefined)).toBe(true);
		});

		it('tells a caller with a dead login to sign in (403), for an ARC that is not public', async () => {
			const res = await call(handler, REPOS.alpha, 'nologin', 'session');
			expect(res.status).toBe(403);
			expect(res.body.metadata.status[0]).toMatchObject({ messageType: 'ERROR' });
			expect(res.body.message).toMatch(/sign in to MIRA again/i);
			expect(res.body).not.toHaveProperty('result');
		});

		it('returns 503 with Retry-After and no data when PLANTdataHUB does not answer', async () => {
			gitlab.failProjects(500);
			const res = await call(handler, REPOS.alpha, 'alice', 'session');
			expect(res.status).toBe(503);
			expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
			expect(res.body.metadata.status[0]).toMatchObject({ messageType: 'ERROR' });
			expect(res.body).not.toHaveProperty('result');
		});
	});

	describe('a caller who can read the ARC', () => {
		const serving = HANDLERS.filter(([file]) => !file.includes('mcpd'));
		it.each(serving)(
			'%s answers 200 to a session and to a token of the same user',
			async (_f, handler) => {
				const session = await call(handler, REPOS.alpha, 'alice', 'session');
				const token = await call(handler, REPOS.alpha, 'alice', 'token');
				expect(session.status).toBe(200);
				expect(token.status).toBe(200);
				expect(token.body).toEqual(session.body);
				expect(token.locals.authMethod).toBe('token');
			}
		);

		it('a token request uses the token owner, not who else is signed in', async () => {
			const trials = HANDLERS.find(([f]) => f.includes('trials'))![1];
			const res = await callBrapi(trials, {
				repo: REPOS.alpha,
				locals: authenticatedLocals('alice'), // a cookie of a member ...
				headers: bearer(bobToken) // ... does not help a token of a non-member
			});
			expect(res.status).toBe(404);
		});
	});

	describe('one GitLab answer is reused for the same user and ARC', () => {
		it('a second request is served from the cache, with no new PLANTdataHUB call', async () => {
			const trials = HANDLERS.find(([f]) => f.includes('trials'))![1];
			await call(trials, REPOS.alpha, 'alice', 'session');
			const calls = gitlab.projectCalls().length;
			await call(trials, REPOS.alpha, 'alice', 'token');
			expect(gitlab.projectCalls()).toHaveLength(calls);
		});
	});

	it('does not ask PLANTdataHUB about an unknown repo', async () => {
		const trials = HANDLERS.find(([f]) => f.includes('trials'))![1];
		expect((await call(trials, 'No/Such-Arc', 'alice', 'session')).status).toBe(404);
		expect(gitlab.projectCalls()).toHaveLength(0);
	});
});

placeholderWithoutDb('BrAPI per-ARC access');
