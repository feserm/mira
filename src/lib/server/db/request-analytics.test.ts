/** The dashboard's endpoint popularity groups by route pattern, for new rows (S2.9) and for the raw
 *  paths older rows still hold. Real Postgres as the DML role. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestLogs } from '$lib/server/db/schema';
import { useTestDb } from '$lib/server/test-support/db-mock';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import { getDashboardAnalytics, normalizeEndpoint } from './request-analytics';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);

describe('normalizeEndpoint', () => {
	it.each([
		['/[repo]/brapi/v2/trials', '/trials'],
		['/Group%2FAlpha/brapi/v2/trials', '/trials'],
		['/some-repo/brapi/v2/trials', '/trials'],
		['/[repo]/brapi/v2/germplasm/[germplasmDbId]/mcpd', '/germplasm/[germplasmDbId]/mcpd'],
		['/some-repo/brapi/v2/germplasm/g-123/mcpd', '/germplasm/[germplasmDbId]/mcpd'],
		['/[repo]/brapi/v2', '/'],
		['(unmatched)', '(unmatched)']
	])('%s -> %s', (stored, shown) => {
		expect(normalizeEndpoint(stored)).toBe(shown);
	});
});

describe.skipIf(!hasTestDb)('getDashboardAnalytics (real Postgres)', () => {
	let t: DmlTestDb;
	const now = new Date('2026-10-26T12:00:00Z');
	const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(async () => {
		await t.db.delete(requestLogs);
	});

	const row = (endpoint: string, createdAt: Date, method = 'GET', ms = 10) => ({
		endpoint,
		method,
		responseTimeMs: ms,
		status: 200,
		createdAt
	});

	it('puts route patterns and raw paths of the same endpoint in one group', async () => {
		await t.db.insert(requestLogs).values([
			row('/[repo]/brapi/v2/trials', daysAgo(1)),
			row('/[repo]/brapi/v2/trials', daysAgo(1)),
			row('/[repo]/brapi/v2/trials', daysAgo(2)),
			// written before S2.9
			row('/Group%2FAlpha/brapi/v2/trials', daysAgo(40)),
			row('/other-repo/brapi/v2/trials', daysAgo(40)),
			row('/[repo]/brapi/v2/germplasm/[germplasmDbId]/mcpd', daysAgo(1)),
			row('/old-repo/brapi/v2/germplasm/g-1/mcpd', daysAgo(50)),
			row('/old-repo/brapi/v2/germplasm/g-2/mcpd', daysAgo(50)),
			row('/[repo]/brapi/v2/trials', daysAgo(1), 'POST'),
			row('(unmatched)', daysAgo(1))
		]);

		const { endpointPopularity, responseTimes } = await getDashboardAnalytics(now);
		const byKey = Object.fromEntries(
			endpointPopularity.map((e) => [`${e.method} ${e.path}`, e.requests])
		);
		expect(byKey).toEqual({
			'GET /trials': 5,
			'GET /germplasm/[germplasmDbId]/mcpd': 3,
			'POST /trials': 1,
			'GET (unmatched)': 1
		});
		expect(responseTimes.map((r) => r.name).sort()).toEqual([
			'(unmatched)',
			'/germplasm/[germplasmDbId]/mcpd',
			'/trials',
			'/trials'
		]);
		// no repo slug survives into what the dashboard shows
		expect(JSON.stringify(endpointPopularity)).not.toMatch(/Group|Alpha|other-repo|old-repo/);
	});

	it('reads at most 30 days for the daily chart (retention keeps 90, the chart never shows more)', async () => {
		await t.db
			.insert(requestLogs)
			.values([
				row('/[repo]/brapi/v2/trials', daysAgo(0)),
				row('/[repo]/brapi/v2/trials', daysAgo(29)),
				row('/[repo]/brapi/v2/trials', daysAgo(30)),
				row('/[repo]/brapi/v2/trials', daysAgo(60))
			]);
		const { dailyRequests, endpointPopularity } = await getDashboardAnalytics(now);
		expect(dailyRequests).toHaveLength(30);
		expect(dailyRequests.reduce((n, d) => n + d.requests, 0)).toBe(2);
		// popularity and the median cover every row still stored, which retention bounds
		expect(endpointPopularity[0].requests).toBe(4);
	});
});
