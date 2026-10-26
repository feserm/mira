import { error } from '@sveltejs/kit';
import { resolveReadableArc } from '$lib/server/brapi/arc';
import type { BrapiServerInfo, BrapiService } from '$lib/types/brapi/core';
import { brapiJson, brapiSingleResponse } from '$lib/server/brapi/response';
import { authenticateBrapi } from '$lib/server/brapi/auth';
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

const AUTH_DESCRIPTION =
	'Read-only BrAPI server. Authentication: send "Authorization: Bearer <API token>" (create a token ' +
	'under /account/tokens after signing in), or use the browser session cookie. Requests without valid ' +
	'credentials get 401 with "WWW-Authenticate: Bearer"; token requests are rate limited (429, Retry-After).';

function parseContentType(param: string, value: string | null): string | undefined {
	if (value === null) return undefined;
	if (!CONTENT_TYPES.includes(value)) error(400, `Invalid ${param}: "${value}"`);
	return value;
}

export const GET: RequestHandler = async (event) => {
	await authenticateBrapi(event);

	await resolveReadableArc(event);

	const params = event.url.searchParams;
	const contentType =
		parseContentType('contentType', params.get('contentType')) ??
		parseContentType('dataType', params.get('dataType'));

	const calls = contentType
		? CALLS.filter((call) => call.contentTypes.includes(contentType))
		: CALLS;

	// BrAPI 2.1's ServerInfo has no field for the authentication method, so it goes in the standard
	// human-readable ones. Clients that need it in code read `WWW-Authenticate: Bearer` on a 401.
	const result: BrapiServerInfo = {
		serverName: 'MIRA',
		serverDescription: AUTH_DESCRIPTION,
		documentationURL: `${event.url.origin}/account/tokens`,
		calls
	};

	return brapiJson(brapiSingleResponse(result));
};
