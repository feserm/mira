/** better-auth's rate limiter as deployed (S2.7): counters in Postgres (as the DML-only role: the
 *  `rate_limit` table is covered by the default privileges), the client taken from X-Forwarded-For the way
 *  the hook does it, 429 with `Retry-After`. The real hook, the real better-auth, a real database; only
 *  PLANTdataHUB (discovery, for the sign-in call) is the stub. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authRateLimitHits, registry } from '$lib/server/metrics';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import { useTestDb } from '$lib/server/test-support/db-mock';
import { stubGitlab } from '$lib/server/test-support/gitlab-stub';
import { AUTH_RATE_LIMIT, withRetryAfter } from './auth-rate-limit';

vi.mock('$app/environment', () => ({ building: false }));
vi.mock('$app/server', () => ({ getRequestEvent: () => ({}) }));
vi.mock(
	'$lib/server/env',
	async () => (await import('$lib/server/test-support/env-mock')).envModule
);
vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock('$lib/server/db/request-logs', () => ({
	enqueueRequestLog: () => {},
	flushAndStop: async () => {}
}));

type Hook = typeof import('../../hooks.server');
let hook: Hook;
let seq = 0;

function event(
	path: string,
	options: { headers?: Record<string, string>; method?: string; body?: string; peer?: string } = {}
) {
	const url = new URL(`https://mira.test${path}`);
	return {
		url,
		route: { id: '/api/auth/[...all]' },
		request: new Request(url, {
			method: options.method ?? 'GET',
			headers: options.headers,
			body: options.body
		}),
		locals: {} as Record<string, unknown>,
		getClientAddress: () => options.peer ?? '10.0.0.1',
		setHeaders: () => {}
	};
}

/** One request to the app, as the ingress would forward it: `forwardedFor` is the X-Forwarded-For value. */
async function call(
	hookModule: Hook,
	path: string,
	forwardedFor: string,
	options: { method?: string; body?: string; headers?: Record<string, string> } = {}
) {
	const resolve = vi.fn(async () => new Response('page'));
	return hookModule.handle({
		event: event(path, {
			...options,
			headers: { 'x-forwarded-for': forwardedFor, ...options.headers }
		}),
		resolve
	} as unknown as Parameters<Hook['handle']>[0]);
}

/** Calls `path` until it is refused; returns how many were let through (at most `cap`). */
async function untilRefused(hookModule: Hook, path: string, forwardedFor: string, cap: number) {
	for (let n = 0; n < cap; n++) {
		const res = await call(hookModule, path, forwardedFor);
		if (res.status === 429) return { allowed: n, refusal: res };
	}
	return { allowed: cap, refusal: undefined };
}

describe.skipIf(!hasTestDb)('better-auth rate limit (real Postgres, DML-only role)', () => {
	let t: DmlTestDb;
	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
		hook = await import('../../hooks.server');
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(async () => {
		seq++;
		await t.client`delete from rate_limit`;
	});

	// a client address per test, so the tests do not count against each other
	const client = () => `203.0.113.${(seq % 200) + 1}`;

	it('lets 100 requests per 10 s through for one client and path, then answers 429 with Retry-After', async () => {
		expect(AUTH_RATE_LIMIT).toEqual({ window: 10, max: 100 });
		const before = authRateLimitHits.value();
		const { allowed, refusal } = await untilRefused(hook, '/api/auth/ok', client(), 150);
		expect(allowed).toBe(100);
		expect(refusal?.status).toBe(429);
		const wait = Number(refusal?.headers.get('retry-after'));
		expect(wait).toBeGreaterThanOrEqual(1);
		expect(wait).toBeLessThanOrEqual(10);
		expect(refusal?.headers.get('x-retry-after')).toBe(String(wait)); // better-auth's own header is kept
		expect(await refusal?.json()).toEqual({
			message: 'Too many requests. Please try again later.'
		});
		expect(authRateLimitHits.value()).toBe(before + 1);
		expect(await registry.render()).toContain('mira_auth_rate_limit_hits_total');
	});

	it('counts per client: one client being refused does not touch another', async () => {
		const a = client();
		const b = `198.51.100.${(seq % 200) + 1}`;
		await untilRefused(hook, '/api/auth/ok', a, 150);
		expect((await call(hook, '/api/auth/ok', a)).status).toBe(429);
		expect((await call(hook, '/api/auth/ok', b)).status).toBe(200);
	});

	it('counts per path as well', async () => {
		const a = client();
		await untilRefused(hook, '/api/auth/ok', a, 150);
		expect((await call(hook, '/api/auth/error', a)).status).not.toBe(429);
	});

	it('takes the client from the right end of X-Forwarded-For: a spoofed left end changes nothing', async () => {
		const real = client();
		let refused = 0;
		for (let i = 0; i < 130; i++) {
			// every request claims a different origin at the left; the ingress appended `real`
			const res = await call(hook, '/api/auth/ok', `10.9.${i % 250}.${(i * 7) % 250}, ${real}`);
			if (res.status === 429) refused++;
		}
		expect(refused).toBe(30);
		// and what is stored is the real address, not anything the client wrote
		const keys = (await t.client`select key from rate_limit`).map((r) => r.key as string);
		expect(keys).toEqual([`${real}|/ok`]);
	});

	it('ignores an address the client puts in the header the limiter reads', async () => {
		const real = client();
		for (let i = 0; i < 100; i++)
			await call(hook, '/api/auth/ok', real, {
				headers: { 'x-mira-client-address': `7.7.7.${i}` }
			});
		const res = await call(hook, '/api/auth/ok', real, {
			headers: { 'x-mira-client-address': '7.7.7.200' }
		});
		expect(res.status).toBe(429);
	});

	it('uses the socket peer when there is no X-Forwarded-For (a call from inside the cluster)', async () => {
		const resolve = vi.fn(async () => new Response('page'));
		const run = (peer: string) =>
			hook.handle({
				event: event('/api/auth/ok', { peer }),
				resolve
			} as unknown as Parameters<Hook['handle']>[0]);
		for (let i = 0; i < 100; i++) await run('10.5.5.5');
		expect((await run('10.5.5.5')).status).toBe(429);
		expect((await run('10.5.5.6')).status).toBe(200);
		const keys = (await t.client`select key from rate_limit`).map((r) => r.key as string);
		expect(keys.sort()).toEqual(['10.5.5.5|/ok', '10.5.5.6|/ok']);
	});

	it('shares the counters between pods and keeps them across a restart (they are in the database)', async () => {
		const a = client();
		await untilRefused(hook, '/api/auth/ok', a, 150);
		vi.resetModules(); // a new process: a new better-auth, no memory of the old one
		const second = await import('../../hooks.server');
		expect(second).not.toBe(hook);
		expect((await call(second, '/api/auth/ok', a)).status).toBe(429);
		expect((await call(second, '/api/auth/ok', `192.0.2.${(seq % 200) + 1}`)).status).toBe(200);
	});

	it('/get-session allows 300 per 10 s, more than the default: it runs on every page load', async () => {
		const { allowed } = await untilRefused(hook, '/api/auth/get-session', client(), 350);
		expect(allowed).toBe(300);
	});

	it("starting a sign-in is limited to 30 per minute per client, not better-auth's default of 3 per 10 s", async () => {
		stubGitlab();
		try {
			const a = client();
			const signIn = () =>
				call(hook, '/api/auth/sign-in/oauth2', a, {
					method: 'POST',
					headers: { origin: 'https://mira.test', 'content-type': 'application/json' },
					body: JSON.stringify({ providerId: 'oidc', callbackURL: '/arcs' })
				});
			const statuses: number[] = [];
			for (let i = 0; i < 31; i++) statuses.push((await signIn()).status);
			expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
			expect(statuses[30]).toBe(429);
			const retry = Number((await signIn()).headers.get('retry-after'));
			expect(retry).toBeGreaterThan(10); // a minute window, not ten seconds
			expect(retry).toBeLessThanOrEqual(60);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('a page request is not counted at all', async () => {
		for (let i = 0; i < 120; i++) expect((await call(hook, '/arcs', client())).status).toBe(200);
		expect(await t.client`select 1 from rate_limit`).toHaveLength(0);
	});

	it('the table is writable by the DML role and holds one row per client and path', async () => {
		await call(hook, '/api/auth/ok', '203.0.113.250');
		await call(hook, '/api/auth/ok', '203.0.113.250');
		const rows = await t.client`select key, count from rate_limit`;
		expect(rows).toEqual([{ key: '203.0.113.250|/ok', count: 2 }]);
	});
});

describe('withRetryAfter', () => {
	it("copies better-auth's X-Retry-After into Retry-After on a 429 only", () => {
		const limited = withRetryAfter(
			new Response('x', { status: 429, headers: { 'x-retry-after': '7' } })
		);
		expect(limited.headers.get('retry-after')).toBe('7');
		const fine = withRetryAfter(
			new Response('x', { status: 200, headers: { 'x-retry-after': '7' } })
		);
		expect(fine.headers.has('retry-after')).toBe(false);
		const bare = withRetryAfter(new Response('x', { status: 429 }));
		expect(bare.headers.has('retry-after')).toBe(false);
	});

	it('works on a response with immutable headers', () => {
		const res = new Response('x', { status: 429, headers: { 'x-retry-after': '3' } });
		Object.defineProperty(res, 'headers', {
			value: new Proxy(res.headers, {
				get(target, prop) {
					if (prop === 'set') throw new TypeError('immutable');
					const v = Reflect.get(target, prop);
					return typeof v === 'function' ? v.bind(target) : v;
				}
			})
		});
		expect(withRetryAfter(res).headers.get('retry-after')).toBe('3');
	});
});
