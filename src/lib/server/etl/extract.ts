import { error, type RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import { getAccessToken, getArc, roCrateDownloadUrl } from '$lib/server/plantdatahub';

export async function extractRoCrate(event: RequestEvent, arcId: number): Promise<void> {
	const token = await getAccessToken(event);
	const [project, res] = await Promise.all([
		getArc(token, String(arcId)),
		fetch(roCrateDownloadUrl(String(arcId)), {
			headers: { Authorization: `Bearer ${token}` }
		})
	]);
	if (!res.ok) {
		error(res.status === 404 ? 404 : 502, 'Could not fetch RO-Crate metadata from PLANTdataHUB');
	}

	const raw = await res.json();
	const userId = event.locals.user!.id;
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
