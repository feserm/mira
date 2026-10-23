import { error } from '@sveltejs/kit';

export interface BrapiStatus {
	message: string;
	messageType?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
}

export interface BrapiPagination {
	currentPage: number;
	pageSize: number;
	totalCount: number;
	totalPages: number;
}

export interface BrapiListResponse<T> {
	metadata: {
		datafiles: unknown[];
		pagination: BrapiPagination;
		status: BrapiStatus[];
	};
	result: {
		data: T[];
	};
}

export interface BrapiSingleResponse<T> {
	metadata: {
		datafiles: unknown[];
		status: BrapiStatus[];
	};
	result: T;
}

const DEFAULT_PAGE_SIZE = 1000;

/**
 * Parses BrAPI's `page`/`pageSize` query params. Missing params fall back to BrAPI's
 * documented defaults (page 0, pageSize 1000); present-but-invalid values are a client
 * error (trust boundary), not silently coerced.
 */
export function parseBrapiPagination(searchParams: URLSearchParams): {
	page: number;
	pageSize: number;
} {
	const pageParam = searchParams.get('page');
	const pageSizeParam = searchParams.get('pageSize');

	const page = pageParam === null ? 0 : Number(pageParam);
	const pageSize = pageSizeParam === null ? DEFAULT_PAGE_SIZE : Number(pageSizeParam);

	if (!Number.isInteger(page) || page < 0) error(400, `Invalid page: "${pageParam}"`);
	if (!Number.isInteger(pageSize) || pageSize < 1)
		error(400, `Invalid pageSize: "${pageSizeParam}"`);

	return { page, pageSize };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDbId(value: string): boolean {
	return UUID.test(value);
}

/**
 * True if any `*DbId` filter is not a UUID. Every id this server hands out is a UUID, so such a
 * filter can match nothing, and passing it on would make Postgres reject the query with a 500.
 * List handlers answer an empty page instead, which is what BrAPI clients expect for no match.
 * `observationUnitLevelRelationshipDbId` is compared as text, not as a uuid column.
 */
export function hasMalformedDbId(searchParams: URLSearchParams): boolean {
	for (const [key, value] of searchParams) {
		if (key.endsWith('DbId') && key !== 'observationUnitLevelRelationshipDbId' && !isDbId(value))
			return true;
	}
	return false;
}

/** Wraps a page of results in the BrAPI standard list response envelope. */
export function brapiListResponse<T>(
	data: T[],
	page: number,
	pageSize: number,
	totalCount: number
): BrapiListResponse<T> {
	return {
		metadata: {
			datafiles: [],
			pagination: {
				currentPage: page,
				pageSize,
				totalCount,
				totalPages: Math.ceil(totalCount / pageSize)
			},
			status: []
		},
		result: { data }
	};
}

/** Wraps a single result in the BrAPI standard non-paginated response envelope. */
export function brapiSingleResponse<T>(result: T): BrapiSingleResponse<T> {
	return {
		metadata: { datafiles: [], status: [] },
		result
	};
}

export function brapiJson(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json' }
	});
}
