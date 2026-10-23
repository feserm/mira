import { betterAuth } from 'better-auth/minimal';
import { config } from '$lib/server/env';
import { baseAuthOptions, sharedPlugins } from '$lib/server/auth-options';
import { findOidcAccountId } from '$lib/server/oidc-account';
import { TokenError } from './errors';
import { RefreshLockTimeoutError, withRefreshLock } from '$lib/server/token-refresh-lock';

// The web app's `auth` needs a request (cookie plugin, `$app/server`). The worker has none, so it
// has its own instance with the same options and no cookie plugin; it is only used to read and
// refresh a user's stored OIDC token.
const workerAuth = betterAuth({
	...baseAuthOptions,
	secret: config.authSecret,
	plugins: sharedPlugins()
});

export const SIGN_IN_AGAIN =
	'PLANTdataHUB access could not be refreshed for the user who started this import (their sign-in may have expired or been revoked, or PLANTdataHUB was unreachable). Sign in again and retry.';

/** The importing user's PLANTdataHUB access token, refreshed by better-auth if it is about to expire.
 *  No request or session is involved: better-auth accepts a `userId` for server-side calls. The
 *  refresh runs under the per-user lock (`token-refresh-lock.ts`) shared with the web app. A failure
 *  to get the token is a `TokenError` (not retried); a lock wait that timed out is transient and
 *  rethrown as it is, so the job is retried. */
export async function getWorkerAccessToken(userId: string): Promise<string> {
	const accountId = await findOidcAccountId(userId);
	if (!accountId) throw new TokenError('No linked PLANTdataHUB account. Sign in again and retry.');

	try {
		const tokens = await withRefreshLock(userId, accountId, () =>
			workerAuth.api.getAccessToken({ body: { providerId: 'oidc', accountId, userId } })
		);
		if (!tokens?.accessToken) throw new TokenError(SIGN_IN_AGAIN);
		return tokens.accessToken;
	} catch (e) {
		if (e instanceof TokenError || e instanceof RefreshLockTimeoutError) throw e;
		console.error('etl: token refresh failed:', e instanceof Error ? e.message : e);
		throw new TokenError(SIGN_IN_AGAIN);
	}
}
