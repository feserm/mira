import type { Handle, HandleServerError } from '@sveltejs/kit';
import { building } from '$app/environment';
import { config } from '$lib/server/env'; // validates configuration at server start
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { flushAndStop } from '$lib/server/db/request-logs';
import { closeDb } from '$lib/server/db';
import { errorMessage, logger } from '$lib/server/log';
import { logServerError, observeRequest } from '$lib/server/observability';
import { securityHeaders } from '$lib/server/security-headers';
import { CSP_REPORT_PATH } from '$lib/server/csp-directives';
import { AUTH_PATH_PREFIX, observeAuthResponse, pinAuthClient } from '$lib/server/auth-rate-limit';

// Probe and scrape paths bypass session lookup, request logging and request metrics: kubelet and
// Prometheus send no cookies and must not write a log line or a request_logs row every few seconds.
// /metrics checks its own bearer token (routes/metrics/+server.ts). /csp-report is browsers reporting a
// violation, which can come in bursts and needs no session: it counts itself (routes/csp-report).
const PROBE_PATHS = new Set(['/healthz', '/readyz', '/metrics', CSP_REPORT_PATH]);

// Every response gets these, probes included: six header writes cost nothing.
const addSecurityHeaders = securityHeaders({
	cspMode: config.security.cspMode,
	hstsMaxAgeSeconds: config.security.hstsMaxAgeSeconds,
	https: config.origin.startsWith('https:')
});

// adapter-node traps SIGTERM/SIGINT itself, stops accepting connections, waits for in-flight
// requests, and only then emits 'sveltekit:shutdown'. Hooking that event (rather than the signals)
// means the final request logs are enqueued before we flush. Once our listeners finish, nothing
// keeps the event loop alive and the process exits. The globalThis flag keeps dev HMR (which
// re-evaluates this module) from stacking listeners.
const SHUTDOWN_REGISTERED = Symbol.for('mira.shutdownRegistered');
const globals = globalThis as typeof globalThis & { [SHUTDOWN_REGISTERED]?: boolean };

if (!building && !globals[SHUTDOWN_REGISTERED]) {
	globals[SHUTDOWN_REGISTERED] = true;
	(process as NodeJS.EventEmitter).once('sveltekit:shutdown', async (reason: string) => {
		logger.info(`Shutting down (${reason}): flushing request logs and closing the database pool`);
		try {
			await flushAndStop();
			await closeDb();
		} catch (error) {
			logger.error(`Error during shutdown: ${errorMessage(error)}`);
			process.exitCode = 1;
		}
	});
}

const BRAPI_PATH = /^\/[^/]+\/brapi\/v2(?:\/|$)/;

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	if (!event.url.pathname.startsWith(AUTH_PATH_PREFIX))
		return svelteKitHandler({ event, resolve, auth, building });

	pinAuthClient(event); // the client address the sign-in rate limit counts by
	return observeAuthResponse(await svelteKitHandler({ event, resolve, auth, building }));
};

export const handle: Handle = async ({ event, resolve }) => {
	if (PROBE_PATHS.has(event.url.pathname)) return addSecurityHeaders(await resolve(event));

	const observation = observeRequest(event);
	let status = 500;

	try {
		const response = await handleBetterAuth({ event, resolve });
		status = response.status;
		return addSecurityHeaders(observation.stamp(response));
	} finally {
		observation.finish(status, { brapi: BRAPI_PATH.test(event.url.pathname) });
	}
};

// One JSON line (message only) instead of the framework's default, which prints the error object.
export const handleError: HandleServerError = (input) => logServerError(input);
