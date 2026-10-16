/** Calls a real BrAPI `+server.ts` handler with a fake request event and returns what a client would
 *  see. All "who is the caller" knowledge lives in `authenticatedLocals()`: when the user is
 *  established differently (bearer token, API token), change that one function, not every test. */
import { isHttpError } from '@sveltejs/kit';

export type Locals = { user?: { id: string; email: string; name: string }; session?: unknown };

/** The caller of an authenticated request. */
export function authenticatedLocals(userId = 'user-1'): Locals {
	return {
		user: { id: userId, email: `${userId}@example.org`, name: 'Test User' },
		session: { id: `session-${userId}`, userId }
	};
}

/** A request with no usable credentials. */
export function anonymousLocals(): Locals {
	return {};
}

export interface BrapiResult {
	status: number;
	/** parsed JSON body for a response; `{ message }` for a thrown HTTP error */
	body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface CallOptions {
	repo: string;
	/** query parameters, e.g. { pageSize: 1, sortBy: 'studyName' } */
	query?: Record<string, string | number | boolean>;
	/** extra route params, e.g. { germplasmDbId } */
	params?: Record<string, string>;
	/** default: an authenticated caller. Pass `anonymousLocals()` to test the 401 path. */
	locals?: Locals;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BrapiHandler = (event: any) => Response | Promise<Response>;

export async function callBrapi(handler: BrapiHandler, opts: CallOptions): Promise<BrapiResult> {
	const url = new URL(`http://localhost/${encodeURIComponent(opts.repo)}/brapi/v2/test`);
	for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
	const event = {
		locals: opts.locals ?? authenticatedLocals(),
		params: { repo: opts.repo, ...opts.params },
		url,
		request: new Request(url)
	};
	try {
		const res = await handler(event);
		return { status: res.status, body: await res.json() };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body };
		throw e;
	}
}
