import { error, type RequestEvent } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import { auth } from '$lib/server/auth';
import { findOidcAccountId } from '$lib/server/oidc-account';
import { RefreshLockTimeoutError, withRefreshLock } from '$lib/server/token-refresh-lock';

/** The signed-in user's PLANTdataHUB (GitLab) access token, refreshed by better-auth if expired.
 *  Web requests only: it needs the request's session. The ETL worker has no request and uses
 *  `etl/worker-auth.ts` instead. */
export async function getAccessToken(event: RequestEvent): Promise<string> {
	const userId = event.locals.user?.id;
	if (!userId) error(401, 'Not signed in');

	const accountId = await findOidcAccountId(userId);
	if (!accountId) {
		error(403, 'No linked PLANTdataHUB account. Please log in again.');
	}

	let tokens;
	try {
		tokens = await withRefreshLock(userId, accountId, () =>
			auth.api.getAccessToken({
				body: { providerId: 'oidc', accountId },
				headers: event.request.headers
			})
		);
	} catch (e) {
		if (e instanceof RefreshLockTimeoutError) {
			error(503, 'PLANTdataHUB access is being renewed by another request. Please try again.');
		}
		// better-auth reports every token problem (no refresh token, refresh refused, a stored token it
		// cannot decrypt after BETTER_AUTH_SECRET changed) as one generic APIError.
		if (e instanceof APIError) {
			error(401, 'Could not obtain a PLANTdataHUB access token. Please log in again.');
		}
		throw e;
	}

	if (!tokens?.accessToken) {
		error(401, 'Could not obtain a PLANTdataHUB access token. Please log in again.');
	}

	return tokens.accessToken;
}
