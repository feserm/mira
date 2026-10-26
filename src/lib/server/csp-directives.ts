/** The Content-Security-Policy of the app, as SvelteKit's `kit.csp.directives` (vite.config.ts). A file of
 *  its own with no imports, because the Vite config reads it before any alias exists. SvelteKit adds a
 *  fresh nonce per request to `script-src` and `style-src` for the inline script and styles it generates;
 *  `security-headers.ts` then decides at run time whether the header blocks or only reports.
 *
 *  What is in it and why (checked against the built app in a real browser, docs/security-headers.md):
 *  - no `unsafe-inline` and no `unsafe-eval` for scripts: the only inline script is SvelteKit's, with its nonce;
 *  - `style-src-attr 'unsafe-inline'`: `style="width: 40%"` attributes (the dashboard bars, `app.html`) cannot
 *    carry a nonce. An attribute cannot run script, so this is the narrow exception, not `style-src`;
 *  - `img-src data:`: daisyUI's CSS uses inline SVG data URIs;
 *  - everything else is `'self'` or `'none'`: the app loads nothing from another site. */
import type { KitConfig } from '@sveltejs/kit';

export const CSP_REPORT_PATH = '/csp-report';

export const cspDirectives: NonNullable<NonNullable<KitConfig['csp']>['directives']> = {
	'default-src': ['none'],
	'script-src': ['self'],
	'style-src': ['self'],
	'style-src-attr': ['unsafe-inline'],
	'img-src': ['self', 'data:'],
	'font-src': ['self'],
	'connect-src': ['self'],
	'manifest-src': ['self'],
	'base-uri': ['self'],
	'form-action': ['self'],
	'frame-ancestors': ['none'],
	'object-src': ['none'],
	'report-uri': [CSP_REPORT_PATH]
};
