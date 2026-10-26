import { error, type RequestEvent } from '@sveltejs/kit';
import { accessFailure, checkArcAccess } from '$lib/server/arc-access';

/** What a caller sees for an ARC id that is not a GitLab project, and for one they may not read. */
const NOT_FOUND = 'Not found on PLANTdataHUB';

/**
 * The first line of every `/arcs/[id]` load, action and endpoint that reads or changes what MIRA holds
 * for an ARC (staging row, RO-Crate, job state): the signed-in user must be able to read the ARC on
 * PLANTdataHUB (`arc-access.ts`). Returns the numeric ARC id. Same answers as the BrAPI routes: a
 * 404 for an ARC the user may not read, 403 for an unusable login, 503 with `Retry-After`.
 */
export async function requireArcPageAccess(
	event: Pick<RequestEvent, 'locals' | 'params' | 'setHeaders'>
): Promise<number> {
	const userId = event.locals.user?.id;
	if (!userId) error(401, 'Not signed in');

	const arcId = Number(event.params.id);
	if (!Number.isSafeInteger(arcId) || arcId <= 0) error(404, NOT_FOUND);

	const failure = accessFailure(await checkArcAccess(userId, arcId));
	if (!failure) return arcId;
	if (failure.status === 404) error(404, NOT_FOUND);
	if (failure.retryAfterSeconds)
		event.setHeaders({ 'retry-after': String(failure.retryAfterSeconds) });
	error(failure.status, failure.message!);
}
