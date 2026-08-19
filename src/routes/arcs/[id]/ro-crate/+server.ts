import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) error(401, 'Not signed in');

	const [row] = await db
		.select({ rawRoCrate: roCrateStaging.rawRoCrate })
		.from(roCrateStaging)
		.where(eq(roCrateStaging.arcId, Number(event.params.id)));

	if (!row) error(404, 'RO-Crate has not been imported yet');

	return new Response(JSON.stringify(row.rawRoCrate), {
		headers: {
			'content-type': 'application/json',
			'content-disposition': 'attachment; filename="arc-ro-crate-metadata.json"'
		}
	});
};
