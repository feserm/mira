import { error } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import { accessFailure, checkArcAccess } from '$lib/server/arc-access';
import { brapiError } from '$lib/server/brapi/auth';

/** What a client sees for an ARC that does not exist, and for one it may not read. */
function unknownArc(repo: string): never {
	error(404, `Unknown ARC: "${repo}"`);
}

/**
 * Resolves a BrAPI route's `[repo]` URL segment (the ARC's GitLab project path,
 * matched case-insensitively) to the ARC's numeric id, for scoping BrAPI responses
 * to a single imported ARC. Does not check who may read it: BrAPI handlers use
 * `resolveReadableArc`.
 */
export async function resolveArcId(repo: string): Promise<number> {
	const [row] = await db
		.select({ arcId: roCrateStaging.arcId })
		.from(roCrateStaging)
		.where(sql`lower(${roCrateStaging.path}) = lower(${repo})`);

	if (!row) unknownArc(repo);
	return row.arcId;
}

/**
 * The second line of every BrAPI handler, after `authenticateBrapi(event)`: resolves `[repo]` and
 * checks with PLANTdataHUB that the caller (`locals.user`, the same for a session and for an API
 * token) can read the ARC (`arc-access.ts`, docs/adr/0002-arc-access-control.md). A caller who
 * cannot gets exactly the 404 of an unknown repo; an unusable login is a 403 and an unreachable
 * PLANTdataHUB a 503 with `Retry-After`. Returns the ARC id only on `allow`.
 */
export async function resolveReadableArc(event: {
	params: { repo: string };
	locals: App.Locals;
	setHeaders: (headers: Record<string, string>) => void;
}): Promise<number> {
	const arcId = await resolveArcId(event.params.repo);
	const userId = event.locals.user?.id;
	if (!userId) brapiError(401, 'Not signed in'); // authenticateBrapi comes first; never serve without a caller

	const failure = accessFailure(await checkArcAccess(userId, arcId));
	if (!failure) return arcId;
	if (failure.status === 404) unknownArc(event.params.repo);
	if (failure.retryAfterSeconds)
		event.setHeaders({ 'retry-after': String(failure.retryAfterSeconds) });
	return brapiError(failure.status, failure.message!);
}
