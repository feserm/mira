import { error } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';

/**
 * Resolves a BrAPI route's `[repo]` URL segment (the ARC's GitLab project path,
 * matched case-insensitively) to the ARC's numeric id, for scoping BrAPI responses
 * to a single imported ARC.
 */
export async function resolveArcId(repo: string): Promise<number> {
	const [row] = await db
		.select({ arcId: roCrateStaging.arcId })
		.from(roCrateStaging)
		.where(sql`lower(${roCrateStaging.path}) = lower(${repo})`);

	if (!row) error(404, `Unknown ARC: "${repo}"`);
	return row.arcId;
}
