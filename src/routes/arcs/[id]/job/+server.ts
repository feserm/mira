import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireArcPageAccess } from '$lib/server/arc-page-access';
import { getLatestJob } from '$lib/server/etl/queue';
import { toJobView } from '$lib/server/etl/job-view';
import type { RequestHandler } from './$types';

/** The page polls this while an import is queued or running. Same access rule as the page itself:
 *  the user must be able to read the ARC on PLANTdataHUB. */
export const GET: RequestHandler = async (event) => {
	const arcId = await requireArcPageAccess(event);
	const job = await getLatestJob(db, arcId);
	return json({ job: toJobView(job) }, { headers: { 'cache-control': 'no-store' } });
};
