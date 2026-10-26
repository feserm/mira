import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '$lib/server/env';
import { registry } from '$lib/server/metrics';
import '$lib/server/metrics-collectors';
import type { RequestHandler } from './$types';

/** Prometheus scrape endpoint (docs/observability.md, docs/adr/0003-metrics-endpoint.md).
 *
 *  Protected by its own bearer token, `METRICS_TOKEN` (a Secret in the chart). It is not a MIRA API
 *  token and not a session: `hooks.server.ts` lets `/metrics` bypass the session lookup, so a signed-in
 *  user's cookie and a `mira_...` API token are just a wrong credential here. With no `METRICS_TOKEN`
 *  configured the endpoint does not exist (404). Metrics are per pod. */
const noStore = { 'cache-control': 'no-store' };

function matches(presented: string, expected: string): boolean {
	// hash both so the comparison has a fixed length and does not leak the token's
	const a = createHash('sha256').update(presented).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

export const GET: RequestHandler = async ({ request }) => {
	const expected = config.metricsToken;
	if (!expected) return new Response('Not found', { status: 404, headers: noStore });

	const header = request.headers.get('authorization') ?? '';
	const presented = /^Bearer +(\S+)$/i.exec(header.trim())?.[1];
	if (!presented || !matches(presented, expected)) {
		return new Response('Unauthorized', {
			status: 401,
			headers: { ...noStore, 'www-authenticate': 'Bearer' }
		});
	}

	return new Response(await registry.render(), {
		headers: { ...noStore, 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }
	});
};
