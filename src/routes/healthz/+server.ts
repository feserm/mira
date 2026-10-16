import type { RequestHandler } from './$types';

/** Liveness probe: proves only that the event loop is serving requests. Deliberately touches
 *  neither the database nor auth, so a DB outage never gets pods restarted. */
export const GET: RequestHandler = () =>
	new Response('ok', { headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } });
