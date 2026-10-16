import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import { getArc, plantdatahubFetch, roCrateDownloadUrl } from '$lib/server/plantdatahub';

export async function extractRoCrate(token: string, userId: string, arcId: number): Promise<void> {
	const [project, res] = await Promise.all([
		getArc(token, String(arcId)),
		plantdatahubFetch(roCrateDownloadUrl(String(arcId)), token)
	]);
	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			error(res.status, 'PLANTdataHUB denied access to the RO-Crate metadata');
		}
		error(
			res.status === 404 ? 404 : res.status >= 500 || res.status === 429 ? 502 : 500,
			'Could not fetch RO-Crate metadata from PLANTdataHUB'
		);
	}

	const raw = await res.json();
	const now = new Date();

	await db
		.insert(roCrateStaging)
		.values({
			arcId,
			path: project.path,
			rawRoCrate: raw,
			extractStatus: 'success',
			extractedAt: now,
			extractedBy: userId
		})
		.onConflictDoUpdate({
			target: roCrateStaging.arcId,
			set: {
				path: project.path,
				rawRoCrate: raw,
				extractStatus: 'success',
				extractError: null,
				extractedAt: now,
				extractedBy: userId
			}
		});
}
