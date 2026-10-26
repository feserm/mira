/** GET /metrics: who can read it, what it exposes, and that its labels cannot grow with traffic.
 *  Real Postgres as the DML role (the ETL gauges read `etl_job`). */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { etlJob } from '$lib/server/db/schema';
import { createApiToken } from '$lib/server/api-token';
import { useTestDb } from '$lib/server/test-support/db-mock';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import { setLogSink } from '$lib/server/log';
import { observeRequest } from '$lib/server/observability';

const TOKEN = 'metrics-token-'.padEnd(40, 'x');
const cfg = vi.hoisted(() => ({
	config: { metricsToken: undefined as string | undefined, db: { poolMax: 10 } }
}));

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock('$lib/server/env', () => cfg);
vi.mock('$lib/server/db/request-logs', () => ({
	enqueueRequestLog: () => {},
	flushAndStop: async () => {}
}));

const { GET } = await import('./+server');

async function scrape(headers: Record<string, string> = {}, locals: Record<string, unknown> = {}) {
	const res = await GET({
		request: new Request('http://localhost/metrics', { headers }),
		locals
	} as unknown as Parameters<typeof GET>[0]);
	return { res, text: await res.text() };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!hasTestDb)('GET /metrics (real Postgres)', () => {
	let t: DmlTestDb;

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
		setLogSink(() => {});
	});
	afterAll(async () => {
		setLogSink(undefined);
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(() => {
		cfg.config.metricsToken = TOKEN;
	});

	describe('protection', () => {
		it('does not exist (404) when no METRICS_TOKEN is configured, even with a credential', async () => {
			cfg.config.metricsToken = undefined;
			expect((await scrape()).res.status).toBe(404);
			expect((await scrape(bearer(TOKEN))).res.status).toBe(404);
		});

		it('401 with WWW-Authenticate without a credential or with a wrong one', async () => {
			for (const headers of [
				{},
				bearer('wrong'),
				bearer(TOKEN + 'x'),
				bearer(TOKEN.slice(0, -1)),
				{ authorization: TOKEN },
				{ authorization: `Basic ${TOKEN}` }
			]) {
				const { res, text } = await scrape(headers);
				expect(res.status).toBe(401);
				expect(res.headers.get('www-authenticate')).toBe('Bearer');
				expect(text).not.toContain('mira_');
			}
		});

		it('is not opened by a signed-in session, an admin, or a MIRA API token', async () => {
			const session = {
				user: { id: t.userId, role: 'admin' },
				session: { id: 's', userId: t.userId }
			};
			expect((await scrape({ cookie: 'better-auth.session_token=abc' }, session)).res.status).toBe(
				401
			);

			const api = await createApiToken(t.userId, 'scrape attempt', 30);
			const withToken = await scrape(bearer(api.token), { ...session, authMethod: 'token' });
			expect(withToken.res.status).toBe(401);
		});

		it('answers 200 with the right token, as text, uncached', async () => {
			const { res, text } = await scrape(bearer(TOKEN));
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toContain('text/plain');
			expect(res.headers.get('cache-control')).toBe('no-store');
			expect(text).toContain('# TYPE mira_token_rate_limit_hits_total counter');
			expect(text).toContain('mira_token_rate_limit_hits_total 0');
		});
	});

	describe('content', () => {
		it('counts requests by method, route pattern and status class', async () => {
			const event = (route: string | null, method = 'GET') =>
				({
					request: new Request('http://localhost/x', { method }),
					locals: {},
					route: { id: route }
				}) as never;
			for (const status of [200, 200, 404]) {
				observeRequest(event('/[repo]/brapi/v2/trials')).finish(status);
			}
			observeRequest(event('/[repo]/brapi/v2/trials', 'POST')).finish(500);

			const { text } = await scrape(bearer(TOKEN));
			expect(text).toMatch(
				/mira_http_requests_total\{method="GET",route="\/\[repo\]\/brapi\/v2\/trials",status_class="2xx"\} \d+/
			);
			expect(text).toContain(
				'mira_http_requests_total{method="POST",route="/[repo]/brapi/v2/trials",status_class="5xx"} 1'
			);
			expect(text).toContain('mira_http_request_duration_seconds_bucket{method="GET"');
		});

		it('labels carry route patterns only: no repo slug, user, ARC or token appears anywhere', async () => {
			// what the hook sees for a request to /Group%2FAlpha/brapi/v2/trials with a token
			observeRequest({
				request: new Request('http://localhost/Group%2FAlpha/brapi/v2/trials?x=Alpha', {
					headers: { authorization: 'Bearer mira_SECRETSECRETSECRETSECRETSECRETSECRETSECRET1' }
				}),
				locals: { user: { id: 'user-with-secret-id' }, authMethod: 'token' },
				route: { id: '/[repo]/brapi/v2/trials' }
			} as never).finish(200);

			const { text } = await scrape(bearer(TOKEN));
			for (const forbidden of ['Group', 'Alpha', 'user-with-secret-id', 'SECRET', 'mira_SECRET']) {
				expect(text).not.toContain(forbidden);
			}
			const labelNames = new Set(
				[...text.matchAll(/^[a-z_:]+\{([^}]*)\}/gm)].flatMap((m) =>
					[...m[1].matchAll(/([a-z_]+)="/g)].map((x) => x[1])
				)
			);
			// a fixed vocabulary: adding a label to a metric must be a conscious change to this list
			expect([...labelNames].sort()).toEqual(
				[
					'collector',
					'credentials',
					'le',
					'method',
					'outcome',
					'reason',
					'result',
					'route',
					'state',
					'status_class'
				].filter((n) => labelNames.has(n))
			);
			for (const n of labelNames) {
				expect([
					'arc',
					'arc_id',
					'user',
					'user_id',
					'repo',
					'path',
					'token',
					'token_id'
				]).not.toContain(n);
			}
		});

		it('reports the import queue read from etl_job, and the connection pool', async () => {
			const base = { kind: 'full' as const, requestedBy: t.userId };
			const ago = (s: number) => new Date(Date.now() - s * 1000);
			await t.db.insert(etlJob).values([
				{ ...base, arcId: 1, state: 'queued', runAfter: ago(120) },
				{ ...base, arcId: 2, state: 'running', startedAt: ago(30) },
				{ ...base, arcId: 3, state: 'succeeded', startedAt: ago(100), finishedAt: ago(90) },
				{ ...base, arcId: 4, state: 'failed', startedAt: ago(50), finishedAt: ago(40) },
				{ ...base, arcId: 5, state: 'failed', startedAt: ago(20), finishedAt: ago(10) }
			]);

			const { text } = await scrape(bearer(TOKEN));
			expect(text).toContain('mira_etl_jobs{state="queued"} 1');
			expect(text).toContain('mira_etl_jobs{state="running"} 1');
			expect(text).toContain('mira_etl_jobs_finished_total{state="succeeded"} 1');
			expect(text).toContain('mira_etl_jobs_finished_total{state="failed"} 2');
			expect(text).toMatch(/mira_etl_job_seconds_total\{state="failed"\} 20(\.0+)?\n/);
			const age = Number(/mira_etl_oldest_queued_age_seconds ([\d.]+)/.exec(text)?.[1]);
			expect(age).toBeGreaterThanOrEqual(119);
			expect(age).toBeLessThan(180);
			expect(text).toContain('mira_db_pool_max_connections 10');
			expect(text).toMatch(/mira_db_pool_open_connections \d+/);
			expect(text).toMatch(/mira_db_ping_seconds [\d.e-]+/);
			expect(text).toContain('process_resident_memory_bytes');
			await t.db.delete(etlJob);
		});

		it('a database failure costs the database metrics, not the scrape', async () => {
			useTestDb({
				execute: () => Promise.reject(new Error('db down'))
			} as never);
			try {
				const { res, text } = await scrape(bearer(TOKEN));
				expect(res.status).toBe(200);
				expect(text).toContain('mira_metrics_collector_errors_total{collector="database"}');
				expect(text).toContain('mira_http_requests_total');
			} finally {
				useTestDb(t.db);
			}
		});
	});
});
