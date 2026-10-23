/** A stand-in for PLANTdataHUB's OIDC endpoints (discovery and the refresh grant), installed as the
 *  global `fetch`. It counts refresh grants and never exposes the tokens it hands out beyond what the
 *  caller passes in. Call `vi.unstubAllGlobals()` afterwards. */
import { vi } from 'vitest';

export interface GitlabStub {
	/** how many `grant_type=refresh_token` requests reached the token endpoint */
	refreshCalls(): number;
}

export interface GitlabStubOptions {
	accessToken: string;
	refreshToken: string;
	/** GitLab semantics: a refresh token works once. The grant answers 400 `invalid_grant` for any
	 *  refresh token but the one issued last (initially this value), and hands out a new one each time. */
	singleUseFrom?: string;
	/** how long the token endpoint takes to answer, so overlapping refreshes really overlap */
	delayMs?: number;
}

export function stubGitlab(opts: GitlabStubOptions): GitlabStub {
	const base = 'https://gitlab.test';
	let refreshes = 0;
	let valid = opts.singleUseFrom;
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `${base}/.well-known/openid-configuration`) {
			return json({
				issuer: base,
				authorization_endpoint: `${base}/oauth/authorize`,
				token_endpoint: `${base}/oauth/token`,
				userinfo_endpoint: `${base}/oauth/userinfo`,
				jwks_uri: `${base}/oauth/discovery/keys`
			});
		}
		if (url === `${base}/oauth/token`) {
			const body = String(init?.body ?? (input instanceof Request ? await input.text() : ''));
			const form = new URLSearchParams(body);
			if (form.get('grant_type') === 'refresh_token') refreshes++;
			if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
			let refreshToken = opts.refreshToken;
			if (valid !== undefined) {
				if (form.get('refresh_token') !== valid) return json({ error: 'invalid_grant' }, 400);
				refreshToken = valid = `${opts.refreshToken}-${refreshes}`;
			}
			return json({
				access_token: opts.accessToken,
				refresh_token: refreshToken,
				token_type: 'Bearer',
				expires_in: 7200,
				scope: 'openid profile email read_api'
			});
		}
		return new Response('not found', { status: 404 });
	});

	return { refreshCalls: () => refreshes };
}
