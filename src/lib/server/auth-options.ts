/** better-auth settings shared by the web app (`auth.ts`) and the ETL worker (`etl/worker-auth.ts`),
 *  so both read and refresh the same linked OIDC account the same way. Free of SvelteKit-only
 *  imports on purpose: the worker bundle cannot resolve `$app/*`. Anything that changes how tokens
 *  are stored (S2.3 encryption) or who may sign in (S2.1, S2.2) belongs here. */
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, genericOAuth } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { config } from '$lib/server/env';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/schema';
import { ADMIN_ROLE, USER_ROLE } from '$lib/server/roles';

/** The role a user with this e-mail address has: admin if `ADMIN_EMAILS` lists it, else user. */
export function roleForEmail(email: string, adminEmails: readonly string[]): string {
	return adminEmails.includes(email.trim().toLowerCase()) ? ADMIN_ROLE : USER_ROLE;
}

/** Makes the stored role match `ADMIN_EMAILS` (in both directions, so the list is the single source
 *  of truth for who is admin). Runs before every session is created, i.e. at each sign-in. */
export async function syncRole(userId: string): Promise<void> {
	const [row] = await db
		.select({ email: user.email, role: user.role })
		.from(user)
		.where(eq(user.id, userId));
	if (!row) return;
	const role = roleForEmail(row.email, config.adminEmails);
	if (row.role !== role) await db.update(user).set({ role }).where(eq(user.id, userId));
}

export const baseAuthOptions = {
	baseURL: config.origin,
	database: drizzleAdapter(db, { provider: 'pg' }),
	// Tokens in `account` are stored encrypted with a key derived from BETTER_AUTH_SECRET (S2.3).
	// Rotating the secret makes them unreadable: docs/secret-rotation.md. (better-auth leaves the
	// `id_token` column in plaintext; it is not a GitLab API credential.)
	account: { encryptOAuthTokens: true },
	databaseHooks: {
		session: {
			create: {
				before: async (session: { userId: string }) => void (await syncRole(session.userId))
			}
		}
	},
	// The admin plugin is only here for the `role` column; MIRA has no use for its HTTP API, and
	// `create-user` / `set-user-password` would let an admin mint e-mail and password users (S2.1).
	disabledPaths: [
		'/admin/set-role',
		'/admin/get-user',
		'/admin/create-user',
		'/admin/update-user',
		'/admin/list-users',
		'/admin/list-user-sessions',
		'/admin/unban-user',
		'/admin/ban-user',
		'/admin/impersonate-user',
		'/admin/stop-impersonating',
		'/admin/revoke-user-session',
		'/admin/revoke-user-sessions',
		'/admin/remove-user',
		'/admin/set-user-password',
		'/admin/has-permission'
	],
	// Login is OIDC only (S2.1): with this off, sign-up and email sign-in answer 400, so the only way
	// a `user` row comes into being is the PLANTdataHUB login.
	emailAndPassword: { enabled: false }
};

/** The plugins both the web app and the worker use: PLANTdataHUB login and the `role` column. */
export const sharedPlugins = (): [ReturnType<typeof oidcPlugin>, ReturnType<typeof admin>] => [
	oidcPlugin(),
	admin()
];

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
