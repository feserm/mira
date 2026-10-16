import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import '$lib/server/env'; // validates configuration at server start
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { enqueueRequestLog, flushAndStop } from '$lib/server/db/request-logs';
import { closeDb } from '$lib/server/db';

// Probe paths bypass session lookup and request logging: kubelet sends no cookies and must not
// write a request_logs row every few seconds.
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

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
		console.log(`Shutting down (${reason}): flushing request logs and closing the database pool`);
		try {
			await flushAndStop();
			await closeDb();
		} catch (error) {
			console.error('Error during shutdown:', error);
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

	if (!BRAPI_PATH.test(event.url.pathname)) return handleBetterAuth({ event, resolve });

	const startedAt = performance.now();
	let status = 500;

	try {
		const response = await handleBetterAuth({ event, resolve });
		status = response.status;
		return response;
	} finally {
		enqueueRequestLog({
			endpoint: event.url.pathname,
			method: event.request.method,
			responseTimeMs: Math.round((performance.now() - startedAt) * 100) / 100,
			status
		});
	}
};
