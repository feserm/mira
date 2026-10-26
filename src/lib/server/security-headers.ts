/** Security headers for every response (S2.7, docs/security-headers.md). Pure: configuration in, a function
 *  that takes a response and returns the one to send. `hooks.server.ts` calls it last, after the request id.
 *
 *  The page CSP is built by SvelteKit (`kit.csp`, vite.config.ts), because only it can put a per-request nonce
 *  on the inline script it generates. SvelteKit sends it as `Content-Security-Policy`; this module then
 *  keeps, renames or drops that header by mode, so report-only versus enforcing is a run-time setting and
 *  not a rebuild. Responses SvelteKit gave no CSP (BrAPI JSON, the auth routes, redirects) get a policy that
 *  allows nothing: nothing they serve should load a resource. */
import type { CspMode } from '$lib/server/env-schema';
import { CSP_REPORT_PATH } from '$lib/server/csp-directives';

const CSP = 'content-security-policy';
const CSP_REPORT_ONLY = 'content-security-policy-report-only';

/** The CSP of a response that is not a SvelteKit page. */
const NOTHING_ALLOWED = `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; report-uri ${CSP_REPORT_PATH}`;

// Features the app never uses. `clipboard-write` (the token copy button) is allowed for the page itself by default.
const PERMISSIONS_POLICY = [
	'accelerometer',
	'autoplay',
	'bluetooth',
	'camera',
	'display-capture',
	'geolocation',
	'gyroscope',
	'magnetometer',
	'microphone',
	'midi',
	'payment',
	'serial',
	'usb'
]
	.map((feature) => `${feature}=()`)
	.join(', ');

export interface SecurityHeaderOptions {
	cspMode: CspMode;
	/** 0 = no HSTS header. */
	hstsMaxAgeSeconds: number;
	/** Whether the public origin is https. HSTS over http is ignored by browsers, so it is not sent. */
	https: boolean;
}

/** The headers that do not depend on the response, as name and value pairs. */
export function staticSecurityHeaders(options: SecurityHeaderOptions): [string, string][] {
	const headers: [string, string][] = [
		['x-content-type-options', 'nosniff'],
		// `frame-ancestors 'none'` in the CSP does the same job in current browsers, but it is not enforced
		// while the CSP is report-only or off, and old browsers ignore it: this one does not depend on the mode.
		['x-frame-options', 'DENY'],
		// The app has no reason to tell PLANTdataHUB (or anyone) which page a user came from.
		['referrer-policy', 'same-origin'],
		['permissions-policy', PERMISSIONS_POLICY],
		// robots.txt asks crawlers to stay away; this covers one that fetches anyway.
		['x-robots-tag', 'noindex, nofollow']
	];
	if (options.https && options.hstsMaxAgeSeconds > 0)
		headers.push(['strict-transport-security', `max-age=${options.hstsMaxAgeSeconds}`]);
	return headers;
}

/** Sets the headers on `response`, or on a copy when its headers are immutable (a `Response.redirect()`),
 *  and returns the response to send. */
export function securityHeaders(options: SecurityHeaderOptions): (response: Response) => Response {
	const fixed = staticSecurityHeaders(options);

	const apply = (headers: Headers) => {
		for (const [name, value] of fixed) headers.set(name, value);

		const fromKit = headers.get(CSP);
		headers.delete(CSP);
		headers.delete(CSP_REPORT_ONLY);
		if (options.cspMode === 'off') return;
		const policy = fromKit ?? NOTHING_ALLOWED;
		headers.set(options.cspMode === 'enforce' ? CSP : CSP_REPORT_ONLY, policy);
	};

	return (response) => {
		try {
			apply(response.headers);
			return response;
		} catch {
			// the first write threw, so nothing was changed on the original
			const copy = new Response(response.body, response);
			apply(copy.headers);
			return copy;
		}
	};
}
