/** Authentication of the BrAPI endpoints: API tokens and the session cookie, through the real
 *  `+server.ts` handlers against Postgres (DML-only role). Token lifecycle details are in
 *  `$lib/server/api-token.test.ts`. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { apiToken } from '$lib/server/db/schema';
import { createApiToken, revokeApiToken } from '$lib/server/api-token';
import { TOKEN_RATE_LIMIT } from '$lib/server/brapi/auth';
import { REPOS, seedBrapiFixture } from '$lib/server/test-support/brapi-fixture';
import {
	anonymousLocals,
	authenticatedLocals,
	bearer,
	callBrapi,
	type BrapiHandler
} from '$lib/server/test-support/brapi-event';
import { useTestDb } from '$lib/server/test-support/db-mock';
import { stubGitlab } from '$lib/server/test-support/gitlab-stub';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import { GET as germplasmGET } from './germplasm/+server';
import { GET as mcpdGET } from './germplasm/[germplasmDbId]/mcpd/+server';
import { GET as locationsGET } from './locations/+server';
import { GET as observationUnitsGET } from './observationunits/+server';
import { GET as serverinfoGET } from './serverinfo/+server';
import { GET as studiesGET } from './studies/+server';
import { GET as trialsGET } from './trials/+server';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock(
	'$lib/server/env',
	async () => (await import('$lib/server/test-support/env-mock')).envModule
);

const ALL_HANDLERS: [string, BrapiHandler][] = [
	['trials', trialsGET],
	['studies', studiesGET],
	['locations', locationsGET],
	['observationunits', observationUnitsGET],
	['germplasm', germplasmGET],
	['serverinfo', serverinfoGET as BrapiHandler],
	['germplasm mcpd', mcpdGET as BrapiHandler]
];

describe.skipIf(!hasTestDb)('BrAPI authentication (real Postgres, DML-only role)', () => {
	let t: DmlTestDb;
	beforeAll(async () => {
		stubGitlab({ unknownProjects: 'public' }); // every ARC is public: these suites are not about access
		t = await createDmlTestDb();
		useTestDb(t.db);
		await seedBrapiFixture(t);
	});
	afterAll(async () => {
		vi.unstubAllGlobals();
		useTestDb(undefined);
		await t?.drop();
	});
	afterEach(() => vi.useRealTimers());

	const trials = (opts: Omit<Parameters<typeof callBrapi>[1], 'repo'>) =>
		callBrapi(trialsGET, { repo: REPOS.alpha, ...opts });
	const newToken = async (days: number | null = 30) =>
		(await createApiToken(t.userId, 't', days)).token;

	it('serves /trials to a valid bearer token and tells the handler who called', async () => {
		const token = await newToken();
		const res = await trials({ locals: anonymousLocals(), headers: bearer(token) });
		expect(res.status).toBe(200);
		expect(res.body.result.data.length).toBeGreaterThan(0);
		expect(res.locals.authMethod).toBe('token');
		expect(res.locals.user?.id).toBe(t.userId);
	});

	it('accepts the scheme case-insensitively', async () => {
		const token = await newToken();
		const res = await trials({
			locals: anonymousLocals(),
			headers: { authorization: `bearer ${token}` }
		});
		expect(res.status).toBe(200);
	});

	it.each(ALL_HANDLERS)(
		'%s goes through the helper: token works, anonymous is refused',
		async (_n, handler) => {
			const token = await newToken();
			const params = { germplasmDbId: '00000000-0000-4000-8000-000000000000' };
			const ok = await callBrapi(handler, {
				repo: REPOS.alpha,
				params,
				locals: anonymousLocals(),
				headers: bearer(token)
			});
			expect(ok.status).not.toBe(401);
			const no = await callBrapi(handler, { repo: REPOS.alpha, params, locals: anonymousLocals() });
			expect(no.status).toBe(401);
		}
	);

	it('still accepts the session cookie, and marks it', async () => {
		const res = await trials({ locals: authenticatedLocals(t.userId) });
		expect(res.status).toBe(200);
		expect(res.locals.authMethod).toBe('session');
	});

	it('still refuses anonymous callers, with WWW-Authenticate and the BrAPI error envelope', async () => {
		const res = await trials({ locals: anonymousLocals() });
		expect(res.status).toBe(401);
		expect(res.headers['www-authenticate']).toBe('Bearer');
		expect(res.body.metadata.status).toEqual([{ message: 'Not signed in', messageType: 'ERROR' }]);
		expect(res.body.metadata.datafiles).toEqual([]);
		expect(res.body).not.toHaveProperty('result');
	});

	describe('a bad bearer header is a 401, never a fallback to the cookie', () => {
		const revokedOrOther = async () => {
			const { token, info } = await createApiToken(t.userId, 'gone', 30);
			await revokeApiToken(t.userId, info.id);
			return token;
		};
		const cases: [string, () => Promise<Record<string, string>>][] = [
			['unknown token', async () => bearer('mira_' + 'x'.repeat(43))],
			['malformed token', async () => bearer('not-a-token')],
			['wrong prefix', async () => bearer('abc_' + 'x'.repeat(43))],
			['wrong scheme', async () => ({ authorization: 'Basic dXNlcjpwdw==' })],
			['empty bearer', async () => ({ authorization: 'Bearer ' })],
			['revoked token', async () => bearer(await revokedOrOther())]
		];

		for (const [name, headers] of cases) {
			it(`${name}: 401 anonymous and with a valid session`, async () => {
				const h = await headers();
				for (const locals of [anonymousLocals(), authenticatedLocals(t.userId)]) {
					const res = await trials({ locals, headers: h });
					expect(res.status).toBe(401);
					expect(res.headers['www-authenticate']).toBe('Bearer');
					expect(res.body.metadata.status[0].messageType).toBe('ERROR');
					expect(res.body).not.toHaveProperty('result');
					// the error never echoes what was sent
					const sent = (h.authorization ?? '').replace(/^\S+ /, '');
					if (sent) expect(JSON.stringify(res.body)).not.toContain(sent);
				}
			});
		}
	});

	it('refuses an expired token according to the clock', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
		const token = await newToken(30);
		expect((await trials({ locals: anonymousLocals(), headers: bearer(token) })).status).toBe(200);
		vi.setSystemTime(new Date('2040-01-31T00:00:01Z'));
		const res = await trials({ locals: anonymousLocals(), headers: bearer(token) });
		expect(res.status).toBe(401);
		vi.useRealTimers();
	});

	it('refuses a token the next request after it is revoked', async () => {
		const { token, info } = await createApiToken(t.userId, 'soon revoked', 30);
		const headers = bearer(token);
		expect((await trials({ locals: anonymousLocals(), headers })).status).toBe(200);
		await revokeApiToken(t.userId, info.id);
		expect((await trials({ locals: anonymousLocals(), headers })).status).toBe(401);
	});

	it('records last use, and a failing update does not fail the request', async () => {
		const { token, info } = await createApiToken(t.userId, 'tracked', 30);
		expect((await trials({ locals: anonymousLocals(), headers: bearer(token) })).status).toBe(200);
		for (let i = 0; i < 50; i++) {
			const [r] = await t.db.select().from(apiToken).where(eq(apiToken.id, info.id));
			if (r.lastUsedAt) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		const [stored] = await t.db.select().from(apiToken).where(eq(apiToken.id, info.id));
		expect(stored.lastUsedAt).toBeInstanceOf(Date);

		const failing = await createApiToken(t.userId, 'failing write', 30);
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const spy = vi.spyOn(t.db, 'update').mockImplementation(() => {
			throw new Error('db down');
		});
		const res = await trials({ locals: anonymousLocals(), headers: bearer(failing.token) });
		spy.mockRestore();
		err.mockRestore();
		expect(res.status).toBe(200);
	});

	it('rate limits one token with 429 and Retry-After, without affecting another token', async () => {
		const busy = await newToken();
		const quiet = await newToken();
		for (let i = 0; i < TOKEN_RATE_LIMIT.max; i++) {
			expect((await trials({ locals: anonymousLocals(), headers: bearer(busy) })).status).toBe(200);
		}
		const limited = await trials({ locals: anonymousLocals(), headers: bearer(busy) });
		expect(limited.status).toBe(429);
		expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
		expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(
			TOKEN_RATE_LIMIT.windowMs / 1000
		);
		expect(limited.body).not.toHaveProperty('result');
		expect((await trials({ locals: anonymousLocals(), headers: bearer(quiet) })).status).toBe(200);
		// the session cookie is not subject to the token limit
		expect((await trials({ locals: authenticatedLocals(t.userId) })).status).toBe(200);
	});
});
