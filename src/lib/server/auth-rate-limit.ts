/** better-auth's rate limiter for `/api/auth/*` (S2.7, docs/rate-limits.md): where its counters live, how
 *  it knows the client, and the limits. Web only (the worker serves no HTTP), so it is merged in
 *  `auth.ts` and not in `auth-options.ts`, which the worker bundles.
 *
 *  Storage is the database (table `rate_limit`, migration 0007): the limit holds across replicas and
 *  restarts, and there is no Redis in the cluster. Cost: one read and one write per auth request, on
 *  endpoints a browser calls a few times per page at most. better-auth removes expired rows itself, but only
 *  at the moment some other key's window rolls over, so a quiet instance can hold stale rows; they are
 *  tiny, and keys are `<address>|<path>`. */
import type { RequestEvent } from '@sveltejs/kit';
import { config } from '$lib/server/env';
import { CLIENT_ADDRESS_HEADER, pinClientAddress } from '$lib/server/client-address';
import { authRateLimitHits } from '$lib/server/metrics';

/** Every path better-auth serves. `svelteKitHandler` only routes these to it. */
export const AUTH_PATH_PREFIX = '/api/auth/';

/** Default for every path: this many requests per window per client address and path. */
export const AUTH_RATE_LIMIT = { window: 10, max: 100 };

export const authRateLimitOptions = {
	rateLimit: {
		// Explicit: better-auth's default is "on only when NODE_ENV=production", which would leave dev and
		// the tests running a different configuration from the deployment.
		enabled: true,
		storage: 'database' as const,
		...AUTH_RATE_LIMIT,
		customRules: {
			// Starting a sign-in writes a `verification` row and redirects to PLANTdataHUB. better-auth's
			// default for `/sign-in/*` is 3 per 10 s, meant for password forms; here a whole institute can sit
			// behind one address and sign in at 09:00. 30 per minute per address is 0.5 per second: no human
			// notices it, a script does.
			'/sign-in/oauth2': { window: 60, max: 30 },
			// The browser asks who is signed in on page loads and navigation. A NAT of 200 colleagues must not
			// share 10 requests per second; this is 30.
			'/get-session': { window: 10, max: 300 }
		}
	},
	advanced: {
		ipAddress: {
			// The hook writes the address it worked out into this header (client-address.ts). Not
			// X-Forwarded-For: better-auth would read the left end, which a client controls.
			ipAddressHeaders: [CLIENT_ADDRESS_HEADER]
		}
	}
};

/** Before the request goes to better-auth: tells it the client's address (see client-address.ts). The
 *  header is written on `event.request` itself, which better-auth then reads; nothing else uses it. */
export function pinAuthClient(event: Pick<RequestEvent, 'request' | 'getClientAddress'>): void {
	pinClientAddress(event.request.headers, {
		xffDepth: config.proxy.xffDepth,
		// ADDRESS_HEADER is unset, so this is the socket peer; if someone sets it, a request without that
		// header throws, and no address then means better-auth's shared bucket
		peer: () => {
			try {
				return event.getClientAddress();
			} catch {
				return undefined;
			}
		}
	});
}

/** After better-auth answered: `Retry-After` on a 429, and the count. */
export function observeAuthResponse(response: Response): Response {
	if (response.status === 429) authRateLimitHits.inc();
	return withRetryAfter(response);
}

/** better-auth says how long to wait in `X-Retry-After`; HTTP's header is `Retry-After`. Adds it, on a
 *  copy if the headers are immutable. */
export function withRetryAfter(response: Response): Response {
	const seconds = response.headers.get('x-retry-after');
	if (response.status !== 429 || seconds === null || response.headers.has('retry-after'))
		return response;
	try {
		response.headers.set('retry-after', seconds);
		return response;
	} catch {
		const copy = new Response(response.body, response);
		copy.headers.set('retry-after', seconds);
		return copy;
	}
}
