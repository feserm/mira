import { error } from '@sveltejs/kit';
import { config } from '$lib/server/env';
import { fetchWithTimeout, type FetchLimits } from '$lib/server/fetch-timeout';
import type { GitlabProjectDetail, GitlabProjectSummary, Pagination } from '$lib/types/gitlab';

// PLANTdataHUB's OIDC issuer is the GitLab instance itself, so the same host
// serves the REST API and the OIDC-derived access token doubles as a GitLab API token.
const PLANTDATAHUB_URL = config.oidc.issuerUrl;

/** Every PLANTdataHUB request goes through this, so none can hang. */
export const plantdatahubLimits: FetchLimits = {
	headersMs: config.http.headersTimeoutSeconds * 1000,
	totalMs: config.http.totalTimeoutSeconds * 1000
};

export function plantdatahubFetch(url: string, token: string): Promise<Response> {
	return fetchWithTimeout(
		url,
		{ headers: { Authorization: `Bearer ${token}` } },
		plantdatahubLimits
	);
}

async function gitlabFetch(path: string, token: string): Promise<Response> {
	const res = await plantdatahubFetch(`${PLANTDATAHUB_URL}${path}`, token);

	if (!res.ok) {
		if (res.status === 401) {
			error(
				401,
				'PLANTdataHUB rejected the access token. Please log in again (read_api scope required).'
			);
		}
		if (res.status === 403) {
			error(403, 'PLANTdataHUB denied access to this resource');
		}
		if (res.status === 404) {
			error(404, 'Not found on PLANTdataHUB');
		}
		// 5xx and 429 are worth retrying (the ETL worker does); other 4xx are our own mistake.
		error(
			res.status >= 500 || res.status === 429 ? 502 : 500,
			`PLANTdataHUB API request failed (${res.status})`
		);
	}

	return res;
}

/** One project, as lightly as possible (no statistics, no license), for the per-request access check
 *  (`arc-access.ts`). Without a `token` the call is anonymous. Redirects are not followed: with public
 *  access restricted GitLab redirects an anonymous API call to its sign-in page, and the HTML behind
 *  the redirect must never be mistaken for an answer. The caller reads the status. */
export function fetchProjectForAccess(id: number, token?: string): Promise<Response> {
	return fetchWithTimeout(
		`${PLANTDATAHUB_URL}/api/v4/projects/${id}`,
		{
			redirect: 'manual',
			headers: token ? { Authorization: `Bearer ${token}` } : undefined
		},
		plantdatahubLimits
	);
}

export interface ListArcsParams {
	search: string;
	page: number;
	perPage: number;
}

export async function listArcs(
	token: string,
	{ search, page, perPage }: ListArcsParams
): Promise<{ items: GitlabProjectSummary[]; pagination: Pagination }> {
	const params = new URLSearchParams({
		archived: 'false',
		order_by: 'last_activity_at',
		sort: 'desc',
		simple: 'true',
		page: String(page),
		per_page: String(perPage)
	});
	if (search) params.set('search', search);

	const res = await gitlabFetch(`/api/v4/projects?${params}`, token);
	const items = (await res.json()) as GitlabProjectSummary[];

	const pagination: Pagination = {
		page: Number(res.headers.get('x-page') ?? page),
		perPage: Number(res.headers.get('x-per-page') ?? perPage),
		totalPages: Number(res.headers.get('x-total-pages') ?? 1),
		total: Number(res.headers.get('x-total') ?? items.length)
	};

	return { items, pagination };
}

export async function getArc(token: string, id: string): Promise<GitlabProjectDetail> {
	const res = await gitlabFetch(
		`/api/v4/projects/${encodeURIComponent(id)}?statistics=true&license=true`,
		token
	);
	return (await res.json()) as GitlabProjectDetail;
}

export function roCrateDownloadUrl(id: string): string {
	return `${PLANTDATAHUB_URL}/api/v4/projects/${encodeURIComponent(id)}/packages/generic/isa_arc_json/0.0.1/arc-ro-crate-metadata.json`;
}
