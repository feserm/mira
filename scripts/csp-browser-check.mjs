// Loads the BUILT app in a real Chromium and looks for Content-Security-Policy violations on the pages
// a person uses (S2.7). The policy is run in `enforce` mode on purpose: a violation then also breaks the
// page, which a screenshot-free script can see (the widgets are missing). Needs:
//   - `pnpm build` done, and a throwaway Postgres with the migrations applied (docs/testing.md),
//   - `pnpm exec playwright install chromium` done once.
//   DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres node scripts/csp-browser-check.mjs
// What it stands in for PLANTdataHUB: a tiny HTTP server (OIDC discovery, the project list and project
// calls). A real login cannot be done here: the session is seeded in the database with a signed cookie
// instead, exactly the cookie better-auth would have set. So this proves the pages under the policy, and
// that the sign-in click reaches the identity provider's address; it does not prove PLANTdataHUB itself.
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import postgres from 'postgres';
import { symmetricEncrypt } from 'better-auth/crypto';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL)
	throw new Error('set DATABASE_URL (a throwaway database with the migrations applied)');
const APP = 'http://localhost:3999';
const STUB_PORT = 3998;
const SECRET = '0123456789abcdef0123456789abcdef';
const failures = [];
const note = (ok, message) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
	if (!ok) failures.push(message);
};

// ---- the stand-in for PLANTdataHUB -------------------------------------------------------------------------
const project = {
	id: 1,
	name: 'Demo ARC',
	name_with_namespace: 'Group / Demo ARC',
	path: 'demo-arc',
	path_with_namespace: 'group/demo-arc',
	description: 'A demo ARC',
	avatar_url: null,
	web_url: `http://127.0.0.1:${STUB_PORT}/group/demo-arc`,
	star_count: 0,
	forks_count: 0,
	visibility: 'public',
	archived: false,
	last_activity_at: new Date().toISOString(),
	namespace: { id: 1, name: 'Group', path: 'group', kind: 'group', full_path: 'group' }
};
const stub = createServer((req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`);
	const json = (body, headers = {}) => {
		res.writeHead(200, { 'content-type': 'application/json', ...headers });
		res.end(JSON.stringify(body));
	};
	if (url.pathname === '/.well-known/openid-configuration')
		return json({
			issuer: `http://127.0.0.1:${STUB_PORT}`,
			authorization_endpoint: `http://127.0.0.1:${STUB_PORT}/oauth/authorize`,
			token_endpoint: `http://127.0.0.1:${STUB_PORT}/oauth/token`,
			userinfo_endpoint: `http://127.0.0.1:${STUB_PORT}/oauth/userinfo`,
			jwks_uri: `http://127.0.0.1:${STUB_PORT}/oauth/discovery/keys`
		});
	if (url.pathname === '/api/v4/projects')
		return json([project], {
			'x-page': '1',
			'x-per-page': '24',
			'x-total-pages': '1',
			'x-total': '1'
		});
	if (url.pathname.startsWith('/api/v4/projects/')) return json(project);
	res.writeHead(200, { 'content-type': 'text/plain' });
	res.end('stub identity provider');
});
await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));

// ---- the app, built, in enforce mode -------------------------------------------------------------------------
const server = spawn('node', ['build/index.js'], {
	env: {
		...process.env,
		DATABASE_URL,
		ORIGIN: APP,
		PORT: '3999',
		BETTER_AUTH_SECRET: SECRET,
		OIDC_ISSUER_URL: `http://127.0.0.1:${STUB_PORT}`,
		OIDC_CLIENT_ID: 'ci',
		NODE_ENV: 'development', // lets ORIGIN be http; the build is the production build
		CSP_MODE: 'enforce',
		XFF_DEPTH: '1',
		ADMIN_EMAILS: 'csp@example.org',
		METRICS_TOKEN: 'm'.repeat(40)
	},
	stdio: ['ignore', 'ignore', 'inherit']
});
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

async function cleanup() {
	server.kill();
	stub.close();
	await sql.end({ timeout: 2 });
}

try {
	for (let i = 0; i < 50; i++) {
		if (
			await fetch(`${APP}/healthz`)
				.then((r) => r.ok)
				.catch(() => false)
		)
			break;
		await new Promise((r) => setTimeout(r, 200));
	}

	// ---- a signed-in user: user, login (encrypted like better-auth stores it), session, some traffic -----------
	const userId = 'csp-user';
	const token = 'csp-session-token-0123456789abcdef';
	await sql`delete from session where user_id = ${userId}`;
	await sql`delete from account where user_id = ${userId}`;
	await sql`delete from "user" where id = ${userId}`;
	await sql`insert into "user" (id, name, email, email_verified) values (${userId}, 'CSP Check', 'csp@example.org', true)`;
	await sql`insert into account (id, account_id, provider_id, user_id, access_token, refresh_token, access_token_expires_at, updated_at)
		values ('csp-acc', 'gl-1', 'oidc', ${userId},
			${await symmetricEncrypt({ key: SECRET, data: 'glpat-stub' })},
			${await symmetricEncrypt({ key: SECRET, data: 'glrt-stub' })},
			${new Date(Date.now() + 3_600_000)}, now())`;
	await sql`insert into session (id, token, user_id, expires_at, updated_at)
		values ('csp-session', ${token}, ${userId}, ${new Date(Date.now() + 3_600_000)}, now())`;
	for (let i = 0; i < 30; i++)
		await sql`insert into request_logs (endpoint, method, response_time_ms, status, created_at)
			values (${i % 2 ? '/[repo]/brapi/v2/trials' : '/[repo]/brapi/v2/studies'}, 'GET', ${20 + i * 3}, 200,
				${new Date(Date.now() - i * 3_600_000)})`;
	const signature = createHmac('sha256', SECRET).update(token).digest('base64');
	const cookie = encodeURIComponent(`${token}.${signature}`);

	// ---- the browser -----------------------------------------------------------------------------------------------
	// CHROMIUM_PATH: a browser Playwright did not install itself (when its own download does not match this Playwright version)
	const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
	const context = await browser.newContext();
	const violations = [];
	await context.addInitScript(() => {
		window.__violations = [];
		document.addEventListener('securitypolicyviolation', (e) =>
			window.__violations.push(
				`${e.violatedDirective} blocked=${e.blockedURI} sample=${e.sample ?? ''}`
			)
		);
	});

	async function visit(label, path, { expectText, afterLoad }) {
		const page = await context.newPage();
		const consoleErrors = [];
		page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
		page.on('pageerror', (e) => consoleErrors.push(String(e)));
		const response = await page.goto(`${APP}${path}`, { waitUntil: 'networkidle' });
		const csp = response?.headers()['content-security-policy'] ?? '';
		note(csp.includes("script-src 'self' 'nonce-"), `${label}: enforcing CSP with a script nonce`);
		note(!/script-src[^;]*unsafe-inline/.test(csp), `${label}: no unsafe-inline for scripts`);
		note(
			(await response.allHeaders())['x-frame-options'] === 'DENY',
			`${label}: X-Frame-Options: DENY`
		);
		if (afterLoad) await afterLoad(page);
		await page.waitForLoadState('networkidle');
		const seen = await page.evaluate(() => window.__violations);
		violations.push(...seen.map((v) => `${label}: ${v}`));
		note(
			seen.length === 0,
			`${label}: no CSP violation${seen.length ? ` (${seen.join(' | ')})` : ''}`
		);
		const cspErrors = consoleErrors.filter((e) => /content security policy|refused to/i.test(e));
		note(
			cspErrors.length === 0,
			`${label}: no CSP error in the console${cspErrors.length ? ` (${cspErrors[0]})` : ''}`
		);
		if (expectText) {
			const found = await page
				.getByText(expectText)
				.filter({ visible: true })
				.count()
				.then((n) => n > 0);
			note(found, `${label}: the page rendered ("${expectText}" is visible)`);
		}
		if (process.env.SCREENSHOT_DIR)
			await page.screenshot({
				path: `${process.env.SCREENSHOT_DIR}/${label.replace(/\W+/g, '_')}.png`,
				fullPage: true
			});
		const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
		await page.close();
		return nonce;
	}

	// A control, so that "no violation" above is not just a listener that never fires: an inline script
	// with no nonce must be blocked and reported under this policy.
	{
		const page = await context.newPage();
		await page.goto(`${APP}/`, { waitUntil: 'networkidle' });
		const outcome = await page.evaluate(async () => {
			const el = document.createElement('script');
			el.textContent = 'window.__injected = true';
			document.body.appendChild(el);
			await new Promise((r) => setTimeout(r, 200));
			return { ran: window.__injected === true, reported: window.__violations.length };
		});
		note(
			!outcome.ran && outcome.reported === 1,
			'control: an injected inline script is blocked and reported'
		);
		await page.close();
	}

	// anonymous: the landing page and the sign-in click
	const first = await visit('/ (anonymous)', '/', {
		afterLoad: async (page) => {
			await page
				.getByRole('button', { name: /sign in|log in|login/i })
				.first()
				.click();
			await page
				.waitForURL(`http://127.0.0.1:${STUB_PORT}/**`, { timeout: 10_000 })
				.catch(() => {});
			note(
				page.url().startsWith(`http://127.0.0.1:${STUB_PORT}/oauth/authorize`),
				'/ (anonymous): the sign-in click ended at the identity provider (the stand-in)'
			);
		}
	});
	const second = await visit('/ (anonymous, again)', '/', {});
	note(Boolean(first) && first !== second, 'the nonce differs between two requests');

	await context.addCookies([{ name: 'better-auth.session_token', value: cookie, url: APP }]);
	await visit('/ (dashboard)', '/', { expectText: 'Server Stats' });
	await visit('/arcs', '/arcs', { expectText: 'Demo ARC' });
	await visit('/account/tokens', '/account/tokens', {
		expectText: 'API tokens',
		afterLoad: async (page) => {
			await page.locator('input[name="name"]').fill('csp check');
			await page
				.getByRole('button', { name: /create/i })
				.first()
				.click();
			await page
				.getByText(/mira_/)
				.first()
				.waitFor({ timeout: 10_000 })
				.catch(() => {});
			note(
				await page
					.getByText(/mira_/)
					.first()
					.isVisible()
					.catch(() => false),
				'/account/tokens: creating a token works under the policy'
			);
		}
	});
	await browser.close();

	await new Promise((r) => setTimeout(r, 500)); // browsers send reports a moment late
	const metrics = await fetch(`${APP}/metrics`, {
		headers: { authorization: `Bearer ${'m'.repeat(40)}` }
	}).then((r) => r.text());
	const reports = [...metrics.matchAll(/^mira_csp_violations_total\{([^}]*)\} (\d+)$/gm)];
	note(
		reports.length === 1 &&
			reports[0][2] === '1' &&
			reports[0][1].includes('directive="script-src'),
		`/csp-report counted exactly the control's violation (${reports.map((r) => `${r[1]} ${r[2]}`).join('; ') || 'none'})`
	);
} finally {
	await cleanup();
}

if (failures.length) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log('\nall checks passed');
