import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { enqueueRequestLog } from '$lib/server/db/request-logs';
import { errorMessage, logger } from '$lib/server/log';
import { httpDuration, httpRequests } from '$lib/server/metrics';

/** What a request is called when SvelteKit matched no route (`event.route.id` is null). One fixed
 *  value for all of them, so a scanner probing random paths cannot create series or log rows. */
export const UNMATCHED_ROUTE = '(unmatched)';

// A client-sent id is trusted only if it is short and plain: it goes into a response header and a
// log line, so no spaces, quotes or control characters.
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The inbound `X-Request-Id` when it is sane, else a new UUID. */
export function requestIdFrom(inbound: string | null): string {
	return inbound !== null && REQUEST_ID.test(inbound) ? inbound : randomUUID();
}

// Anything else (a made-up method) would be a free label value.
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

type Event = Pick<RequestEvent, 'request' | 'locals' | 'route'>;

export interface RequestObservation {
	requestId: string;
	/** Adds `X-Request-Id` to the response. Returns the response to send. */
	stamp(response: Response): Response;
	/** Writes the log line and records the metrics; for BrAPI also the `request_logs` row. */
	finish(status: number, options?: { brapi?: boolean }): void;
}

/** Starts timing a request. Everything that identifies it in the log is read in `finish`, after the
 *  handlers ran, because `authenticateBrapi` only then sets `locals.authMethod` and `locals.user`.
 *  Deliberately never reads the URL's query, a header other than `X-Request-Id`, a cookie or the body:
 *  the line carries the route pattern and the status only (BrAPI query strings can hold filters). */
export function observeRequest(event: Event): RequestObservation {
	const startedAt = performance.now();
	const requestId = requestIdFrom(event.request.headers.get('x-request-id'));
	event.locals.requestId = requestId;

	return {
		requestId,
		stamp(response) {
			try {
				response.headers.set('x-request-id', requestId);
				return response;
			} catch {
				// a Response from Response.redirect() has immutable headers
				const copy = new Response(response.body, response);
				copy.headers.set('x-request-id', requestId);
				return copy;
			}
		},
		finish(status, options = {}) {
			const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
			const route = event.route.id ?? UNMATCHED_ROUTE;
			const method = METHODS.has(event.request.method) ? event.request.method : 'OTHER';
			const statusClass = `${Math.floor(status / 100)}xx`;

			httpRequests.inc({ method, route, status_class: statusClass });
			httpDuration.observe({ method, route, status_class: statusClass }, durationMs / 1000);

			const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
			logger[level]('request', {
				requestId,
				method,
				route,
				status,
				durationMs,
				authMethod: event.locals.authMethod,
				userId: event.locals.user?.id
			});

			if (options.brapi) {
				// The route pattern, not the path: the path holds the repo slug and germplasm ids.
				enqueueRequestLog({
					endpoint: route,
					method: event.request.method,
					responseTimeMs: durationMs,
					status
				});
			}
		}
	};
}

/** SvelteKit's `handleError`: an error nobody handled (a thrown exception in a load function or an
 *  endpoint). Logs the **message** and where, as one JSON line, instead of the framework default that
 *  prints the error object (stack, and whatever the error carries). A 404 is not an error here: the
 *  request line already says it. Returns the framework's own safe message to the client. */
export function logServerError(input: {
	error: unknown;
	event: Pick<RequestEvent, 'locals' | 'route' | 'request'>;
	status: number;
	message: string;
}): App.Error {
	const { error, event, status, message } = input;
	if (status !== 404) {
		logger.error(`Unhandled error: ${errorMessage(error)}`, {
			requestId: event.locals.requestId,
			method: event.request.method,
			route: event.route.id ?? UNMATCHED_ROUTE,
			status
		});
	}
	return { message };
}
