import { cspViolations } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

/** Where browsers send Content-Security-Policy violation reports (`report-uri`, csp-directives.ts). It only
 *  counts them: `mira_csp_violations_total{directive,disposition}`. The body is never logged or stored, and
 *  neither is the URL or the page it names (they can hold a query string), so a report cannot put anything
 *  of a visitor's into the logs. Both formats are understood: the legacy `application/csp-report`
 *  (`{"csp-report": {...}}`) and `application/reports+json` (`[{"type":"csp-violation","body":{...}}]`).
 *  Anonymous on purpose: a browser sends no credentials a report could use. The hook lets this path bypass
 *  the session lookup and the request log (hooks.server.ts). */
const MAX_BODY_BYTES = 16 * 1024;

// The label values are this fixed list, never what the report says: a browser (or anyone) can send any text.
const DIRECTIVES = new Set([
	'default-src',
	'script-src',
	'script-src-elem',
	'script-src-attr',
	'style-src',
	'style-src-elem',
	'style-src-attr',
	'img-src',
	'font-src',
	'connect-src',
	'media-src',
	'object-src',
	'frame-src',
	'child-src',
	'worker-src',
	'manifest-src',
	'base-uri',
	'form-action',
	'frame-ancestors',
	'navigate-to'
]);

function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>, otherwise: T): string {
	return typeof value === 'string' && allowed.has(value) ? value : otherwise;
}

/** The directive and disposition of the first report in a body, or undefined if it is not one. */
function parseReport(body: unknown): { directive: unknown; disposition: unknown } | undefined {
	const report = Array.isArray(body) ? body.find((r) => r?.type === 'csp-violation')?.body : body;
	const fields = (report as { 'csp-report'?: object } | undefined)?.['csp-report'] ?? report;
	if (typeof fields !== 'object' || fields === null) return undefined;
	const f = fields as Record<string, unknown>;
	return {
		directive: f['effective-directive'] ?? f.effectiveDirective ?? f['violated-directive'],
		disposition: f.disposition
	};
}

export const POST: RequestHandler = async ({ request }) => {
	const declared = Number(request.headers.get('content-length') ?? 0);
	if (declared > MAX_BODY_BYTES) return new Response(null, { status: 413 });

	let text: string;
	try {
		text = await request.text();
	} catch {
		return new Response(null, { status: 400 });
	}
	// content-length can be absent (chunked) or wrong: the body decides
	if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

	let report: ReturnType<typeof parseReport>;
	try {
		report = parseReport(JSON.parse(text));
	} catch {
		report = undefined;
	}
	if (!report) return new Response(null, { status: 400 });

	// a violated-directive can read "script-src 'self'": keep the name only
	const directive = typeof report.directive === 'string' ? report.directive.split(/\s/)[0] : '';
	cspViolations.inc({
		directive: oneOf(directive, DIRECTIVES, 'other'),
		disposition: oneOf(report.disposition, new Set(['enforce', 'report']), 'unknown')
	});
	return new Response(null, { status: 204 });
};
