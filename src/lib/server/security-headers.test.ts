import { describe, expect, it } from 'vitest';
import { cspDirectives } from './csp-directives';
import { securityHeaders, type SecurityHeaderOptions } from './security-headers';

const options: SecurityHeaderOptions = {
	cspMode: 'report-only',
	hstsMaxAgeSeconds: 15_552_000,
	https: true
};

const PAGE_CSP = "default-src 'none'; script-src 'self' 'nonce-abc'";

function page(csp: string | undefined = PAGE_CSP) {
	const headers = new Headers({ 'content-type': 'text/html' });
	if (csp) headers.set('content-security-policy', csp);
	return new Response('<html></html>', { headers });
}

describe('the headers every response gets', () => {
	it('sets nosniff, frame, referrer, permissions and robots headers, and HSTS on https', () => {
		const res = securityHeaders(options)(new Response('{}'));
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('x-frame-options')).toBe('DENY');
		expect(res.headers.get('referrer-policy')).toBe('same-origin');
		expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		expect(res.headers.get('strict-transport-security')).toBe('max-age=15552000');
		const permissions = res.headers.get('permissions-policy') ?? '';
		for (const feature of ['camera', 'microphone', 'geolocation', 'payment'])
			expect(permissions).toContain(`${feature}=()`);
	});

	it('sends no HSTS over http, or when the max age is 0', () => {
		const http = securityHeaders({ ...options, https: false })(new Response('x'));
		expect(http.headers.has('strict-transport-security')).toBe(false);
		const off = securityHeaders({ ...options, hstsMaxAgeSeconds: 0 })(new Response('x'));
		expect(off.headers.has('strict-transport-security')).toBe(false);
	});

	it('does not leave the response without them when it is a redirect with immutable headers', () => {
		const redirect = Response.redirect('https://mira.test/', 302);
		expect(() => redirect.headers.set('x-probe', '1')).toThrow(); // premise: it really is immutable
		const res = securityHeaders(options)(redirect);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('https://mira.test/');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.has('content-security-policy-report-only')).toBe(true);
	});

	it('keeps status, body and the headers the handler set', async () => {
		const res = securityHeaders(options)(
			new Response('{"a":1}', {
				status: 429,
				headers: { 'retry-after': '7', 'content-type': 'application/json' }
			})
		);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('7');
		expect(await res.text()).toBe('{"a":1}');
	});
});

describe('the Content-Security-Policy by mode', () => {
	it("report-only: SvelteKit's policy is kept as it is, under the report-only name", () => {
		const res = securityHeaders(options)(page());
		expect(res.headers.get('content-security-policy-report-only')).toBe(PAGE_CSP);
		expect(res.headers.has('content-security-policy')).toBe(false);
	});

	it('enforce: the same policy under the enforcing name', () => {
		const res = securityHeaders({ ...options, cspMode: 'enforce' })(page());
		expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP);
		expect(res.headers.has('content-security-policy-report-only')).toBe(false);
	});

	it('off: neither header, whatever SvelteKit sent', () => {
		const res = securityHeaders({ ...options, cspMode: 'off' })(page());
		expect(res.headers.has('content-security-policy')).toBe(false);
		expect(res.headers.has('content-security-policy-report-only')).toBe(false);
		// the other headers do not depend on the mode
		expect(res.headers.get('x-frame-options')).toBe('DENY');
	});

	it('a response with no policy (JSON, a redirect) gets one that allows nothing, in the same mode', () => {
		for (const [cspMode, name] of [
			['enforce', 'content-security-policy'],
			['report-only', 'content-security-policy-report-only']
		] as const) {
			const res = securityHeaders({ ...options, cspMode })(new Response('{}'));
			const policy = res.headers.get(name) ?? '';
			expect(policy).toContain("default-src 'none'");
			expect(policy).toContain("frame-ancestors 'none'");
			expect(policy).not.toContain('unsafe-inline');
		}
	});

	it('does not accumulate a stale second policy when SvelteKit sent both names', () => {
		const headers = new Headers({
			'content-security-policy': PAGE_CSP,
			'content-security-policy-report-only': 'default-src *'
		});
		const res = securityHeaders({ ...options, cspMode: 'enforce' })(new Response('x', { headers }));
		expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP);
		expect(res.headers.has('content-security-policy-report-only')).toBe(false);
	});
});

describe('the policy the app builds with', () => {
	const joined = (name: keyof typeof cspDirectives) => cspDirectives[name].join(' ');

	it('allows no inline or eval script and loads nothing from another site', () => {
		expect(joined('script-src')).toBe('self');
		for (const [name, sources] of Object.entries(cspDirectives)) {
			if (name === 'style-src-attr') continue; // the one documented exception
			expect(sources as readonly string[], name).not.toContain('unsafe-inline');
			expect(sources as readonly string[], name).not.toContain('unsafe-eval');
			expect((sources as readonly string[]).join(' '), name).not.toMatch(/https?:|\*/);
		}
	});

	it('forbids framing and plugins and reports to the app itself', () => {
		expect(joined('frame-ancestors')).toBe('none');
		expect(joined('object-src')).toBe('none');
		expect(joined('default-src')).toBe('none');
		expect(joined('report-uri')).toBe('/csp-report');
	});
});
