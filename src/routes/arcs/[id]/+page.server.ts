import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import { config } from '$lib/server/env';
import { getArc } from '$lib/server/plantdatahub';
import { getAccessToken } from '$lib/server/plantdatahub-token';
import { resolveArcId } from '$lib/server/brapi/arc';
import { requireArcPageAccess } from '$lib/server/arc-page-access';
import { enqueue, getLatestJob, type JobKind } from '$lib/server/etl/queue';
import { toJobView } from '$lib/server/etl/job-view';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	if (!event.locals.user) {
		redirect(303, '/');
	}

	const arcId = await requireArcPageAccess(event);
	const token = await getAccessToken(event);
	const [arc, [staging], job] = await Promise.all([
		getArc(token, String(arcId)),
		db.select().from(roCrateStaging).where(eq(roCrateStaging.arcId, arcId)),
		getLatestJob(db, arcId)
	]);

	// The BrAPI routes are addressed by GitLab project path rather than arcId, so only
	// expose a link to them once that path actually resolves back to this ARC (i.e. it has
	// been staged, and the path hasn't diverged from a GitLab rename since).
	const brapiRepo = await resolveArcId(arc.path)
		.then(() => arc.path)
		.catch(() => null);

	return { arc, staging: staging ?? null, brapiRepo, job: toJobView(job) };
};

/** The ETL runs in the worker (docs/etl-worker.md). The actions only authenticate, check the
 *  preconditions the buttons imply, queue a job and return; the page polls the job's state. */
async function queueJob(event: RequestEvent, kind: JobKind) {
	const user = event.locals.user;
	if (!user) error(401, 'Not signed in');
	const arcId = await requireArcPageAccess(event);

	const { created } = await enqueue(db, {
		arcId,
		kind,
		requestedBy: user.id,
		maxAttempts: config.etl.maxAttempts
	});
	return {
		success: true,
		message: created
			? 'Import queued.'
			: 'An import of this ARC is already queued or running. Showing its progress.'
	};
}

async function stagingStatus(arcId: number) {
	const [row] = await db
		.select({
			extractStatus: roCrateStaging.extractStatus,
			transformStatus: roCrateStaging.transformStatus
		})
		.from(roCrateStaging)
		.where(eq(roCrateStaging.arcId, arcId));
	return row;
}

export const actions: Actions = {
	extract: (event) => queueJob(event, 'full'),

	transform: async (event) => {
		const arcId = await requireArcPageAccess(event);
		const row = await stagingStatus(arcId);
		if (row?.extractStatus !== 'success') {
			return fail(400, { message: 'Extract must succeed before transforming.' });
		}
		return queueJob(event, 'transform');
	},

	load: async (event) => {
		const arcId = await requireArcPageAccess(event);
		const row = await stagingStatus(arcId);
		if (row?.transformStatus !== 'success') {
			return fail(400, { message: 'Transform must succeed before loading.' });
		}
		return queueJob(event, 'load');
	}
};
