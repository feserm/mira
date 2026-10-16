import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import '$lib/server/env'; // validates configuration at server start
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { enqueueRequestLog } from '$lib/server/db/request-logs';

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
