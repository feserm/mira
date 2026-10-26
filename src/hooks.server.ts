import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import '$lib/server/env'; // validates configuration at server start
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { flushAndStop } from '$lib/server/db/request-logs';
import { closeDb } from '$lib/server/db';
import { errorMessage, logger } from '$lib/server/log';
import { observeRequest } from '$lib/server/observability';

// Probe and scrape paths bypass session lookup, request logging and request metrics: kubelet and
// Prometheus send no cookies and must not write a log line or a request_logs row every few seconds.
// /metrics checks its own bearer token (routes/metrics/+server.ts).
const PROBE_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

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

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = async ({ event, resolve }) => {
	if (PROBE_PATHS.has(event.url.pathname)) return resolve(event);

	const observation = observeRequest(event);
	let status = 500;

	try {
		const response = await handleBetterAuth({ event, resolve });
		status = response.status;
		return observation.stamp(response);
	} finally {
		observation.finish(status, { brapi: BRAPI_PATH.test(event.url.pathname) });
	}
};
