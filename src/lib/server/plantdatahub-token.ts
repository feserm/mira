import { error, type RequestEvent } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { findOidcAccountId } from '$lib/server/oidc-account';

/** The signed-in user's PLANTdataHUB (GitLab) access token, refreshed by better-auth if expired.
 *  Web requests only: it needs the request's session. The ETL worker has no request and uses
 *  `etl/worker-token.ts` instead. */
export async function getAccessToken(event: RequestEvent): Promise<string> {
	const userId = event.locals.user?.id;
	if (!userId) error(401, 'Not signed in');

	const accountId = await findOidcAccountId(userId);
	if (!accountId) {
		error(403, 'No linked PLANTdataHUB account. Please log in again.');
	}

	const tokens = await auth.api.getAccessToken({
		body: { providerId: 'oidc', accountId },
		headers: event.request.headers
	});

	if (!tokens?.accessToken) {
		error(401, 'Could not obtain a PLANTdataHUB access token. Please log in again.');
	}

	return tokens.accessToken;
}
