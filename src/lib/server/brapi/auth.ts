import { error, type RequestEvent } from '@sveltejs/kit';
import { TOKEN_PATTERN, touchLastUsed, verifyApiToken } from '$lib/server/api-token';
import { createRateLimiter } from '$lib/server/rate-limit';

type Event = Pick<RequestEvent, 'locals' | 'request' | 'setHeaders'>;

/** Requests per minute for one API token (not per user: a user can hold several). In process memory,
 *  so per pod; ingress limits and better-auth's limiter are S2.7. Constants, not env, on purpose:
 *  change them in code review. Failed attempts are not limited here, see docs/adr/0001-api-tokens.md. */
export const TOKEN_RATE_LIMIT = { max: 60, windowMs: 60_000 };
const tokenLimiter = createRateLimiter(TOKEN_RATE_LIMIT);

/** An error in the BrAPI envelope (`metadata.status`) that also keeps SvelteKit's `message`. */
export function brapiError(status: number, message: string): never {
	error(status, {
		message,
		metadata: { datafiles: [], status: [{ message, messageType: 'ERROR' }] }
	});
}

function unauthorized(event: Event, message: string): never {
	event.setHeaders({ 'www-authenticate': 'Bearer' });
	brapiError(401, message);
}

/** Parses `Authorization`. Undefined when the header is absent; null when present but not a bearer token. */
function bearerToken(request: Request): string | null | undefined {
	const header = request.headers.get('authorization');
	if (header === null) return undefined;
	const match = /^Bearer +(\S+)$/i.exec(header.trim());
	return match ? match[1] : null;
}

/**
 * The one authentication check every BrAPI handler starts with. Accepts `Authorization: Bearer <api
 * token>` or the better-auth session cookie (already in `locals.user`) and returns the caller, or
 * throws 401 (with `WWW-Authenticate: Bearer`) / 429. A bearer header that is present but not a valid
 * active token is always a 401, even when a valid session cookie is sent too: the cookie is never a
 * fallback. On success `locals.user` is the caller and `locals.authMethod` says how they got in.
 * Nothing here checks GitLab access to the ARC: `resolveReadableArc` (`arc.ts`) does, right after.
 */
export async function authenticateBrapi(event: Event, now = new Date()) {
	const presented = bearerToken(event.request);

	if (presented === undefined) {
		if (!event.locals.user) unauthorized(event, 'Not signed in');
		event.locals.authMethod = 'session';
		return event.locals.user;
	}

	// Never echo the presented value, and do not reveal why it was refused.
	if (presented === null || !TOKEN_PATTERN.test(presented)) unauthorized(event, 'Invalid token');
	const verified = await verifyApiToken(presented, now);
	if (!verified) unauthorized(event, 'Invalid token');

	const limit = tokenLimiter.hit(verified.tokenId, now.getTime());
	if (!limit.allowed) {
		event.setHeaders({ 'retry-after': String(limit.retryAfterSeconds) });
		brapiError(429, 'Too many requests');
	}

	touchLastUsed(verified, now);
	event.locals.user = verified.user;
	event.locals.session = undefined;
	event.locals.authMethod = 'token';
	return verified.user;
}
