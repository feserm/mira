/** Stands in for `$lib/server/env` (validated from the real environment at import time) in suites that
 *  reach PLANTdataHUB through the access check. In a test file:
 *
 *    vi.mock('$lib/server/env', async () => (await import('$lib/server/test-support/env-mock')).envModule);
 *
 *  The issuer is `https://gitlab.test`, which `stubGitlab` (gitlab-stub.ts) answers. */
export const TEST_AUTH_SECRET = 'x'.repeat(40);

export const envModule = {
	config: {
		origin: 'https://mira.test',
		authSecret: TEST_AUTH_SECRET,
		adminEmails: [],
		db: { poolMax: 10 },
		security: { cspMode: 'report-only', hstsMaxAgeSeconds: 15_552_000 },
		proxy: { xffDepth: 1 },
		// short, so the test of a hanging PLANTdataHUB is quick
		http: { headersTimeoutSeconds: 1, totalTimeoutSeconds: 2 },
		oidc: {
			issuerUrl: 'https://gitlab.test',
			clientId: 'client',
			clientSecret: 'secret',
			scopes: ['openid', 'profile', 'email', 'read_api']
		},
		etl: { maxAttempts: 3 }
	}
};
