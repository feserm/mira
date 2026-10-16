import { redirect } from '@sveltejs/kit';
import { listArcs } from '$lib/server/plantdatahub';
import { getAccessToken } from '$lib/server/plantdatahub-token';
import type { PageServerLoad } from './$types';

const PER_PAGE = 24;

export const load: PageServerLoad = async (event) => {
	if (!event.locals.user) {
		redirect(303, '/');
	}

	const search = event.url.searchParams.get('q') ?? '';
	const page = Math.max(1, Number(event.url.searchParams.get('page') ?? '1') || 1);

	const token = await getAccessToken(event);
	const { items, pagination } = await listArcs(token, { search, page, perPage: PER_PAGE });

	return { arcs: items, pagination, search };
};
