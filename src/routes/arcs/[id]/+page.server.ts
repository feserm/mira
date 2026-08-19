import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import { getArc, getAccessToken } from '$lib/server/plantdatahub';
import { resolveArcId } from '$lib/server/brapi/arc';
import {
	resetDownstream,
	runExtractStep,
	runTransformStep,
	runLoadStep
} from '$lib/server/etl/pipeline';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	if (!event.locals.user) {
		redirect(303, '/');
	}

	const token = await getAccessToken(event);
	const [arc, [staging]] = await Promise.all([
		getArc(token, event.params.id),
		db
			.select()
			.from(roCrateStaging)
			.where(eq(roCrateStaging.arcId, Number(event.params.id)))
	]);

	// The BrAPI routes are addressed by GitLab project path rather than arcId, so only
	// expose a link to them once that path actually resolves back to this ARC (i.e. it has
	// been staged, and the path hasn't diverged from a GitLab rename since).
	const brapiRepo = await resolveArcId(arc.path)
		.then(() => arc.path)
		.catch(() => null);

	return { arc, staging: staging ?? null, brapiRepo };
};

export const actions: Actions = {
	extract: async (event) => {
		if (!event.locals.user) error(401, 'Not signed in');
		const arcId = Number(event.params.id);

		await resetDownstream(arcId, ['transform', 'load']);

		if (!(await runExtractStep(event, arcId))) {
			return fail(502, { message: 'Extracting the RO-Crate failed.' });
		}

		const [row] = await db
			.select({ rawRoCrate: roCrateStaging.rawRoCrate })
			.from(roCrateStaging)
			.where(eq(roCrateStaging.arcId, arcId));

		if (await runTransformStep(event, arcId, row.rawRoCrate)) {
			await runLoadStep(event, arcId, row.rawRoCrate);
		}

		return { success: true, message: 'RO-Crate imported successfully.' };
	},

	transform: async (event) => {
		if (!event.locals.user) error(401, 'Not signed in');
		const arcId = Number(event.params.id);

		const [row] = await db
			.select({
				rawRoCrate: roCrateStaging.rawRoCrate,
				extractStatus: roCrateStaging.extractStatus
			})
			.from(roCrateStaging)
			.where(eq(roCrateStaging.arcId, arcId));
		if (!row || row.extractStatus !== 'success') {
			return fail(400, { message: 'Extract must succeed before transforming.' });
		}

		await resetDownstream(arcId, ['load']);

		if (await runTransformStep(event, arcId, row.rawRoCrate)) {
			await runLoadStep(event, arcId, row.rawRoCrate);
		}

		return { success: true, message: 'RO-Crate transformed successfully.' };
	},

	load: async (event) => {
		if (!event.locals.user) error(401, 'Not signed in');
		const arcId = Number(event.params.id);

		const [row] = await db
			.select({
				rawRoCrate: roCrateStaging.rawRoCrate,
				transformStatus: roCrateStaging.transformStatus
			})
			.from(roCrateStaging)
			.where(eq(roCrateStaging.arcId, arcId));
		if (!row || row.transformStatus !== 'success') {
			return fail(400, { message: 'Transform must succeed before loading.' });
		}

		await runLoadStep(event, arcId, row.rawRoCrate);

		return { success: true, message: 'RO-Crate loaded successfully.' };
	}
};
