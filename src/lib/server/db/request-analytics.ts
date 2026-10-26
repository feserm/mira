import { and, gte, lt, sql } from 'drizzle-orm';
import { db } from './index';
import { requestLogs } from './schema';

export type EndpointPopularity = {
	path: string;
	method: string;
	requests: number;
};

export type DailyRequests = {
	date: string;
	requests: number;
};

export type ResponseTime = {
	name: string;
	method: string;
	value: number;
};

export type DashboardAnalytics = {
	endpointPopularity: EndpointPopularity[];
	dailyRequests: DailyRequests[];
	responseTimes: ResponseTime[];
	medianResponseTimeMs: number;
};

// `request_logs.endpoint` holds a route pattern since S2.9 (`/[repo]/brapi/v2/germplasm/[germplasmDbId]/mcpd`),
// but rows written before that hold the raw path (`/<repo slug>/brapi/v2/germplasm/<id>/mcpd`). The
// dashboard reads both with the same expression, so old and new rows land in one group: the leading
// repo segment (a slug or `[repo]`) is cut off and a germplasm id (or `[germplasmDbId]`) is collapsed to
// its route slug. Old rows are not migrated; retention (scripts/retention.ts) removes them with the
// rest after the retention period, and until then they still hold repo slugs (docs/observability.md).
const endpointPath = sql<string>`regexp_replace(
	regexp_replace(${requestLogs.endpoint}, '^/[^/]+/brapi/v2', ''),
	'/germplasm/[^/]+/mcpd$', '/germplasm/[germplasmDbId]/mcpd'
)`;

export function normalizeEndpoint(endpoint: string): string {
	const normalized = endpoint.replace(/^\/[^/]+\/brapi\/v2(?=\/|$)/, '') || '/';
	return normalized.replace(/\/germplasm\/[^/]+\/mcpd$/, '/germplasm/[germplasmDbId]/mcpd');
}

function formatDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function startOfDay(date: Date): Date {
	const result = new Date(date);
	result.setUTCHours(0, 0, 0, 0);
	return result;
}

export async function getDashboardAnalytics(now = new Date()): Promise<DashboardAnalytics> {
	const today = startOfDay(now);
	const firstDay = new Date(today);
	firstDay.setUTCDate(firstDay.getUTCDate() - 29);
	const nextDay = new Date(today);
	nextDay.setUTCDate(nextDay.getUTCDate() + 1);

	const [endpointRows, dailyRows, [medianRow]] = await Promise.all([
		db
			.select({
				path: endpointPath,
				method: requestLogs.method,
				requests: sql<number>`count(*)::int`,
				value: sql<number>`percentile_cont(0.5) within group (order by ${requestLogs.responseTimeMs})`
			})
			.from(requestLogs)
			.groupBy(endpointPath, requestLogs.method)
			.orderBy(sql`count(*) desc`),
		db
			.select({
				createdAt: requestLogs.createdAt
			})
			.from(requestLogs)
			.where(and(gte(requestLogs.createdAt, firstDay), lt(requestLogs.createdAt, nextDay))),
		db
			.select({
				value: sql<
					number | null
				>`percentile_cont(0.5) within group (order by ${requestLogs.responseTimeMs})`
			})
			.from(requestLogs)
	]);

	const dailyRequestCounts = new Map<string, number>();
	for (const row of dailyRows) {
		const date = formatDate(row.createdAt);
		dailyRequestCounts.set(date, (dailyRequestCounts.get(date) ?? 0) + 1);
	}
	const dailyRequests: DailyRequests[] = [];
	for (let date = new Date(firstDay); date < nextDay; date.setUTCDate(date.getUTCDate() + 1)) {
		dailyRequests.push({
			date: formatDate(date),
			requests: dailyRequestCounts.get(formatDate(date)) ?? 0
		});
	}

	return {
		endpointPopularity: endpointRows.map((row) => ({
			path: normalizeEndpoint(row.path),
			method: row.method,
			requests: Number(row.requests)
		})),
		dailyRequests,
		responseTimes: endpointRows.map((row) => ({
			name: normalizeEndpoint(row.path),
			method: row.method,
			value: Math.round(Number(row.value))
		})),
		medianResponseTimeMs: Math.round(Number(medianRow?.value ?? 0))
	};
}
