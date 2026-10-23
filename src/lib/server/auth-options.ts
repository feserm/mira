/** better-auth settings shared by the web app (`auth.ts`) and the ETL worker (`etl/worker-auth.ts`),
 *  so both read and refresh the same linked OIDC account the same way. Free of SvelteKit-only
 *  imports on purpose: the worker bundle cannot resolve `$app/*`. Anything that changes how tokens
 *  are stored (e.g. S2.3 encryption) belongs here. */
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins';
import { config } from '$lib/server/env';
import { db } from '$lib/server/db';

export const baseAuthOptions = {
	baseURL: config.origin,
	database: drizzleAdapter(db, { provider: 'pg' }),
	// Login is OIDC only (S2.1): with this off, sign-up and email sign-in answer 400, so the only way
	// a `user` row comes into being is the PLANTdataHUB login.
	emailAndPassword: { enabled: false }
};

export const oidcPlugin = () =>
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
	});
