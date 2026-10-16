import { config } from '$lib/server/env';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';

export const auth = betterAuth({
	baseURL: config.origin,
	// better-auth throws on a missing secret in production mode, and `vite build` imports this
	// module with no env present. The placeholder is never used: the build only analyses the code.
	secret: building ? 'build-time-placeholder-secret-not-used-at-runtime' : config.authSecret,
	database: drizzleAdapter(db, { provider: 'pg' }),
	emailAndPassword: { enabled: true },
	plugins: [
		genericOAuth({
			config: [
				{
					providerId: 'oidc',
					discoveryUrl: `${config.oidc.issuerUrl}/.well-known/openid-configuration`,
					issuer: config.oidc.issuerUrl,
					clientId: config.oidc.clientId,
					clientSecret: config.oidc.clientSecret,
					scopes: config.oidc.scopes,
					pkce: true
				}
			]
		}),
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
