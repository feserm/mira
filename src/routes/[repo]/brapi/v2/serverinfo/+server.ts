import { error } from '@sveltejs/kit';
import { resolveArcId } from '$lib/server/brapi/arc';
import type { BrapiServerInfo, BrapiService } from '$lib/types/brapi/core';
import { brapiJson, brapiSingleResponse } from '$lib/server/brapi/response';
import type { RequestHandler } from './$types';

const CONTENT_TYPES = ['application/json', 'text/csv', 'text/tsv', 'application/flapjack'];

/** Calls implemented by this server, keyed by their BrAPI `service` path. */
const CALLS: BrapiService[] = [
	{
		service: 'serverinfo',
		methods: ['GET'],
		versions: ['2.1'],
		contentTypes: ['application/json']
	},
	{ service: 'germplasm', methods: ['GET'], versions: ['2.1'], contentTypes: ['application/json'] },
	{
		service: 'germplasm/{germplasmDbId}/mcpd',
		methods: ['GET'],
		versions: ['2.1'],
		contentTypes: ['application/json']
	},
	{ service: 'trials', methods: ['GET'], versions: ['2.1'], contentTypes: ['application/json'] },
	{ service: 'studies', methods: ['GET'], versions: ['2.1'], contentTypes: ['application/json'] },
	{ service: 'locations', methods: ['GET'], versions: ['2.1'], contentTypes: ['application/json'] },
	{
		service: 'observationunits',
		methods: ['GET'],
		versions: ['2.1'],
		contentTypes: ['application/json']
	}
];

function parseContentType(param: string, value: string | null): string | undefined {
	if (value === null) return undefined;
	if (!CONTENT_TYPES.includes(value)) error(400, `Invalid ${param}: "${value}"`);
	return value;
}

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) error(401, 'Not signed in');

	await resolveArcId(event.params.repo);

	const params = event.url.searchParams;
	const contentType =
		parseContentType('contentType', params.get('contentType')) ??
		parseContentType('dataType', params.get('dataType'));

	const calls = contentType
		? CALLS.filter((call) => call.contentTypes.includes(contentType))
		: CALLS;

	const result: BrapiServerInfo = { calls };

	return brapiJson(brapiSingleResponse(result));
};
