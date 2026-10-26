import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { errorMessage, logger } from '$lib/server/log';
import type { RequestHandler } from './$types';

const READY_TIMEOUT_MS = 2000;

/** Readiness probe: ready only if Postgres answers `select 1` within a short timeout. */
export const GET: RequestHandler = async () => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			db.execute(sql`select 1`),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS);
			})
		]);
		return new Response('ok', {
			headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' }
		});
	} catch (error) {
		logger.error(`Readiness check failed: ${errorMessage(error)}`);
		return new Response('database unavailable', {
			status: 503,
			headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' }
		});
	} finally {
		clearTimeout(timer);
	}
};
