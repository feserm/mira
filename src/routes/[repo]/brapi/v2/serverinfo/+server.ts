import { error } from '@sveltejs/kit';
import { resolveArcId } from '$lib/server/brapi/arc';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	await resolveArcId(event.params.repo);
	error(404, 'GET /brapi/v2/serverinfo is not implemented yet');
};
