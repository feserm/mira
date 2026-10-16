import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getLatestJob } from '$lib/server/etl/queue';
import { toJobView } from '$lib/server/etl/job-view';
import type { RequestHandler } from './$types';

/** The page polls this while an import is queued or running. Same access rule as the page itself:
 *  any signed-in user (per-ARC authorization is S2.4b). */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) error(401, 'Not signed in');
	const job = await getLatestJob(db, Number(event.params.id));
	return json({ job: toJobView(job) }, { headers: { 'cache-control': 'no-store' } });
};
