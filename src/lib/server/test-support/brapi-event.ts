/** Calls a real BrAPI `+server.ts` handler with a fake request event and returns what a client would
 *  see. All "who is the caller" knowledge lives in `authenticatedLocals()`: when the user is
 *  established differently (bearer token, API token), change that one function, not every test. */
import { isHttpError } from '@sveltejs/kit';

export type Locals = {
	user?: { id: string; email: string; name: string; role?: string | null };
	session?: unknown;
	authMethod?: 'session' | 'token';
};

/** The caller of an authenticated request. */
export function authenticatedLocals(userId = 'user-1', role: 'user' | 'admin' = 'user'): Locals {
	return {
		user: { id: userId, email: `${userId}@example.org`, name: 'Test User', role },
		session: { id: `session-${userId}`, userId }
	};
}

/** An `Authorization: Bearer` header for `CallOptions.headers`. Pair it with `anonymousLocals()`: the
 *  real hook never turns a bearer token into `locals.user`, `authenticateBrapi` does. */
export function bearer(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

/** A request with no usable credentials. */
export function anonymousLocals(): Locals {
	return {};
}

export interface BrapiResult {
	status: number;
	/** parsed JSON body for a response; `{ message }` for a thrown HTTP error */
	body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
	/** headers the handler set with `event.setHeaders` (lower-case names), also on an error */
	headers: Record<string, string>;
	/** the locals after the handler ran: `authMethod` and `user` as `authenticateBrapi` left them */
	locals: Locals;
}

export interface CallOptions {
	repo: string;
	/** query parameters, e.g. { pageSize: 1, sortBy: 'studyName' } */
	query?: Record<string, string | number | boolean>;
	/** extra route params, e.g. { germplasmDbId } */
	params?: Record<string, string>;
	/** default: an authenticated caller. Pass `anonymousLocals()` to test the 401 path. */
	locals?: Locals;
	/** request headers, e.g. `bearer(token)` */
	headers?: Record<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BrapiHandler = (event: any) => Response | Promise<Response>;

export async function callBrapi(handler: BrapiHandler, opts: CallOptions): Promise<BrapiResult> {
	const url = new URL(`http://localhost/${encodeURIComponent(opts.repo)}/brapi/v2/test`);
	for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
	const locals = opts.locals ?? authenticatedLocals();
	const headers: Record<string, string> = {};
	const event = {
		locals,
		params: { repo: opts.repo, ...opts.params },
		url,
		request: new Request(url, { headers: opts.headers }),
		setHeaders: (h: Record<string, string>) => {
			for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
		}
	};
	try {
		const res = await handler(event);
		return { status: res.status, body: await res.json(), headers, locals };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body, headers, locals };
		throw e;
	}
}
