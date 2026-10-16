import { error, type RequestEvent } from '@sveltejs/kit';
import { desc, eq, and } from 'drizzle-orm';
import { config } from '$lib/server/env';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { account } from '$lib/server/db/schema';
import type { GitlabProjectDetail, GitlabProjectSummary, Pagination } from '$lib/types/gitlab';

// PLANTdataHUB's OIDC issuer is the GitLab instance itself, so the same host
// serves the REST API and the OIDC-derived access token doubles as a GitLab API token.
const PLANTDATAHUB_URL = config.oidc.issuerUrl;

export async function getAccessToken(event: RequestEvent): Promise<string> {
	const userId = event.locals.user?.id;
	if (!userId) error(401, 'Not signed in');

	// A user can accumulate more than one linked 'oidc' account row (e.g. GitLab
	// returning a different subject claim across logins). Without an explicit
	// accountId, better-auth's own account lookup isn't ordered by recency and can
	// select a stale row, so pick the most recently linked one ourselves.
	const [oidcAccount] = await db
		.select({ accountId: account.accountId })
		.from(account)
		.where(and(eq(account.userId, userId), eq(account.providerId, 'oidc')))
		.orderBy(desc(account.updatedAt))
		.limit(1);

	if (!oidcAccount) {
		error(403, 'No linked PLANTdataHUB account. Please log in again.');
	}

	const tokens = await auth.api.getAccessToken({
		body: { providerId: 'oidc', accountId: oidcAccount.accountId },
		headers: event.request.headers
	});

	if (!tokens?.accessToken) {
		error(401, 'Could not obtain a PLANTdataHUB access token. Please log in again.');
	}

	return tokens.accessToken;
}

async function gitlabFetch(path: string, token: string): Promise<Response> {
	const res = await fetch(`${PLANTDATAHUB_URL}${path}`, {
		headers: { Authorization: `Bearer ${token}` }
	});

	if (!res.ok) {
		if (res.status === 401) {
			error(
				401,
				'PLANTdataHUB rejected the access token. Please log in again (read_api scope required).'
			);
		}
		if (res.status === 404) {
			error(404, 'Not found on PLANTdataHUB');
		}
		error(502, `PLANTdataHUB API request failed (${res.status})`);
	}

	return res;
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
