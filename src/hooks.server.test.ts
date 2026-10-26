/** The request hook: one JSON log line per request, a request id echoed in the response, the route
 *  pattern (never the path) in the log and in request_logs, probes and the scrape left alone, and no
 *  secret in the log output or in the metrics. Auth and the database are replaced: this is about what
 *  the hook records, not about who may call what. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLogSink } from '$lib/server/log';
import { registry } from '$lib/server/metrics';

const enqueueRequestLog = vi.fn();
const getSession = vi.fn(async () => null);

vi.mock('$app/environment', () => ({ building: true }));
vi.mock('$lib/server/env', () => ({ config: {} }));
vi.mock('$lib/server/db', () => ({ closeDb: async () => {} }));
vi.mock('$lib/server/db/request-logs', () => ({
	enqueueRequestLog: (...args: unknown[]) => enqueueRequestLog(...args),
	flushAndStop: async () => {}
}));
vi.mock('$lib/server/auth', () => ({ auth: { api: { getSession: () => getSession() } } }));
vi.mock('better-auth/svelte-kit', () => ({
	svelteKitHandler: ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) =>
		resolve(event)
}));

const { handle } = await import('./hooks.server');

const lines: string[] = [];
const logged = () => lines.map((l) => JSON.parse(l));

interface Opts {
	path?: string;
	route?: string | null;
	headers?: Record<string, string>;
	method?: string;
	respond?: (event: { locals: Record<string, unknown> }) => Response | Promise<Response>;
}

async function call(opts: Opts = {}) {
	const url = new URL(`http://localhost${opts.path ?? '/arcs'}`);
	const event = {
		url,
		route: { id: opts.route === undefined ? '/arcs' : opts.route },
		request: new Request(url, { method: opts.method ?? 'GET', headers: opts.headers }),
		locals: {} as Record<string, unknown>
	};
	const resolve = vi.fn(async () => (opts.respond ? opts.respond(event) : new Response('ok')));
	const response = await handle({ event, resolve } as unknown as Parameters<typeof handle>[0]);
	return { response, resolve, event };
}

beforeEach(() => {
	setLogSink((l) => lines.push(l));
});
afterEach(() => {
	lines.length = 0;
	enqueueRequestLog.mockReset();
	setLogSink(undefined);
});

describe('request log line', () => {
	it('writes exactly one JSON line per request with the fields an operator needs', async () => {
		await call({ path: '/arcs', route: '/arcs' });
		expect(lines).toHaveLength(1);
		expect(logged()[0]).toMatchObject({
			level: 'info',
			msg: 'request',
			method: 'GET',
			route: '/arcs',
			status: 200
		});
		expect(logged()[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
		expect(logged()[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(new Date(logged()[0].ts).getTime()).not.toBeNaN();
	});

	it('logs the auth method and user id the BrAPI handler established', async () => {
		await call({
			path: '/some-repo/brapi/v2/trials',
			route: '/[repo]/brapi/v2/trials',
			respond: (event) => {
				event.locals.authMethod = 'token';
				event.locals.user = { id: 'user-42' };
				return new Response('{}');
			}
		});
		expect(logged()[0]).toMatchObject({ authMethod: 'token', userId: 'user-42' });
	});

	it('logs 4xx as warn and 5xx as error, and a throwing handler as 500 (and rethrows)', async () => {
		await call({ respond: () => new Response('nope', { status: 404 }) });
		await call({ respond: () => new Response('bad', { status: 503 }) });
		await expect(
			call({
				respond: () => {
					throw new Error('kaput');
				}
			})
		).rejects.toThrow('kaput');
		expect(logged().map((l) => [l.level, l.status])).toEqual([
			['warn', 404],
			['error', 503],
			['error', 500]
		]);
	});

	it('names an unmatched request with one fixed value, whatever was asked for', async () => {
		await call({ path: '/wp-admin/setup.php?x=1', route: null });
		expect(logged()[0].route).toBe('(unmatched)');
		expect(lines[0]).not.toContain('wp-admin');
	});
});

describe('request id', () => {
	it('generates one, and returns it in X-Request-Id', async () => {
		const { response } = await call();
		expect(response.headers.get('x-request-id')).toBe(logged()[0].requestId);
	});

	it('accepts a sane inbound id and echoes it', async () => {
		const { response, event } = await call({ headers: { 'x-request-id': 'client.req-123_A' } });
		expect(response.headers.get('x-request-id')).toBe('client.req-123_A');
		expect(logged()[0].requestId).toBe('client.req-123_A');
		expect(event.locals.requestId).toBe('client.req-123_A');
	});

	it.each([
		['too long', 'a'.repeat(65)],
		['spaces', 'two words'],
		['quotes', 'a"b'],
		['control characters', 'a\tb'],
		['empty', '']
	])('replaces an inbound id that is %s', async (_name, id) => {
		const { response } = await call({ headers: { 'x-request-id': id } });
		const sent = response.headers.get('x-request-id');
		expect(sent).not.toBe(id);
		expect(sent).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('stamps a response whose headers are immutable (a redirect)', async () => {
		const { response } = await call({
			respond: () => Response.redirect('http://localhost/x', 302)
		});
		expect(response.status).toBe(302);
		expect(response.headers.get('x-request-id')).toBeTruthy();
	});
});

describe('probes and the scrape', () => {
	it.each(['/healthz', '/readyz', '/metrics'])(
		'%s: no log line, no session lookup, no row',
		async (path) => {
			getSession.mockClear();
			const { response, resolve } = await call({ path, route: path });
			expect(response.status).toBe(200);
			expect(resolve).toHaveBeenCalledOnce();
			expect(lines).toHaveLength(0);
			expect(getSession).not.toHaveBeenCalled();
			expect(enqueueRequestLog).not.toHaveBeenCalled();
			expect(response.headers.get('x-request-id')).toBeNull();
		}
	);
});

describe('request_logs rows', () => {
	it('stores the route pattern for a BrAPI request, never the path with the repo slug', async () => {
		await call({
			path: '/Group%2FAlpha/brapi/v2/trials?trialName=secretfilter',
			route: '/[repo]/brapi/v2/trials',
			method: 'GET'
		});
		expect(enqueueRequestLog).toHaveBeenCalledOnce();
		const row = enqueueRequestLog.mock.calls[0][0];
		expect(row).toMatchObject({ endpoint: '/[repo]/brapi/v2/trials', method: 'GET', status: 200 });
		expect(JSON.stringify(row)).not.toMatch(/Group|Alpha|secretfilter/);
	});

	it('stores one fixed value when no route matched', async () => {
		await call({ path: '/Group%2FAlpha/brapi/v2/nothing-here', route: null });
		expect(enqueueRequestLog.mock.calls[0][0].endpoint).toBe('(unmatched)');
	});

	it('writes no row for a page that is not BrAPI', async () => {
		await call({ path: '/arcs', route: '/arcs' });
		expect(enqueueRequestLog).not.toHaveBeenCalled();
	});
});

describe('secrets and cardinality', () => {
	it('puts no credential, cookie, query string, path or slug in the log or in /metrics', async () => {
		const token = `mira_${'Zz9Yy8Xx7W'.repeat(4)}`;
		await call({
			path: '/Group%2FAlpha/brapi/v2/trials?trialName=queryvalue&access_token=qtoken',
			route: '/[repo]/brapi/v2/trials',
			headers: {
				authorization: `Bearer ${token}`,
				cookie: 'better-auth.session_token=cookievalue',
				'x-forwarded-for': '203.0.113.9'
			},
			respond: (event) => {
				event.locals.authMethod = 'token';
				event.locals.user = { id: 'user-42' };
				return new Response('{}', { status: 401 });
			}
		});

		const output = lines.join('\n') + (await registry.render());
		for (const secret of [
			token,
			'Bearer',
			'cookievalue',
			'better-auth',
			'queryvalue',
			'qtoken',
			'Group',
			'Alpha',
			'203.0.113.9'
		]) {
			expect(output, `output contains ${secret}`).not.toContain(secret);
		}
		// what a metric label does carry
		expect(output).toContain('route="/[repo]/brapi/v2/trials"');
		expect(output).toContain('status_class="4xx"');
	});

	it('does not let a made-up HTTP method into a label', async () => {
		await call({ method: 'PURGE', route: '/arcs' });
		const output = await registry.render();
		expect(output).toContain('method="OTHER"');
		expect(output).not.toContain('PURGE');
	});
});
