import { config } from '$lib/server/env';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';

export const auth = betterAuth({
	baseURL: config.origin,
	secret: config.authSecret,
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
