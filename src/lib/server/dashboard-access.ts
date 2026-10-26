import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import { checkArcAccess } from '$lib/server/arc-access';

export interface ViewerArcs {
	/** the imported ARCs this viewer can read on PLANTdataHUB right now, by path */
	arcs: { id: number; alias: string }[];
	/** set when some ARCs could not be checked and were left out (fail closed) */
	notice?: string;
}

/** At most this many ARCs are checked at once, so a cold cache does not open hundreds of GitLab
 *  requests together. Answers are shared with the BrAPI guard's cache, so a warm dashboard costs none. */
const CHECK_CONCURRENCY = 6;

async function mapLimited<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				results[i] = await fn(items[i]);
			}
		})
	);
	return results;
}

/**
 * The ARCs the dashboard may list and count for this viewer: every imported ARC, filtered through
 * the same `checkArcAccess` the BrAPI routes use (same cache, same anonymous-first rule), so the
 * dashboard never shows what BrAPI would refuse. Cost: one check per imported ARC, in parallel
 * (bounded); on a cold cache that is up to two PLANTdataHUB calls per ARC (one anonymous, one with
 * the viewer's login for ARCs that are not public), nothing while cached (5 minutes).
 *
 * Fail closed: an ARC that could not be checked (PLANTdataHUB down, the viewer's login unusable) is
 * left out and `notice` says so. It is never counted from stored data.
 */
export async function accessibleArcs(userId: string): Promise<ViewerArcs> {
	const staged = await db
		.select({ id: roCrateStaging.arcId, alias: roCrateStaging.path })
		.from(roCrateStaging)
		.orderBy(roCrateStaging.path);

	const answers = await mapLimited(staged, CHECK_CONCURRENCY, (arc) =>
		checkArcAccess(userId, arc.id)
	);

	const arcs = staged.filter((_, i) => answers[i].kind === 'allow');
	const unavailable = answers.some((a) => a.kind === 'unavailable');
	const unusable = answers.some((a) => a.kind === 'unusable-login');

	let notice: string | undefined;
	if (unavailable) {
		notice =
			'PLANTdataHUB did not answer, so some ARCs could not be checked and are left out. Reload in a moment.';
	} else if (unusable) {
		notice =
			'Your PLANTdataHUB login can no longer be used, so ARCs that are not public are left out. Sign in to MIRA again.';
	}
	return { arcs, notice };
}
