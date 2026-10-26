import { TokenError } from '$lib/server/etl/errors';
import { getWorkerAccessToken } from '$lib/server/etl/worker-auth';
import { errorMessage, logger } from '$lib/server/log';
import { arcAccessCache, arcAccessOutcomes, gitlabRequests } from '$lib/server/metrics';
import { fetchProjectForAccess } from '$lib/server/plantdatahub';

/** Whether a user may read an ARC is decided by PLANTdataHUB (GitLab), per request, never from what
 *  was stored at import time (docs/adr/0002-arc-access-control.md). The ARC id is the GitLab project id.
 *
 *  `checkArcAccess` answers one of four things, cached per (user, ARC) in process memory:
 *  - `allow`: GitLab shows the project to the caller. Asked anonymously first: a `public` project
 *    needs nobody's login. Otherwise the caller's own stored OIDC login is used (for an API token
 *    call: the token owner's), refreshed through the one lock-protected path the ETL worker uses.
 *    A 200 for the caller means: public (anyone), internal (any signed-in user), private (a member).
 *  - `deny`: GitLab answered 404 or 403 for the caller. No such project, as far as they can tell.
 *  - `unusable-login`: the caller has no linked login, GitLab refused to refresh it, or rejected the
 *    refreshed token. Only they can fix it, by signing in to MIRA again.
 *  - `unavailable`: GitLab could not be asked (timeout, network, 5xx, 429, an answer we cannot read,
 *    the refresh lock timed out). Fail closed: no data is returned on this answer. */
export type ArcAccess =
	| { kind: 'allow' }
	| { kind: 'deny' }
	| { kind: 'unusable-login' }
	| { kind: 'unavailable'; retryAfterSeconds: number };

/** How long an `allow` or `deny` is believed. This is also the longest a revoked grant, or a public
 *  ARC turned private, stays readable by a user who read it a moment before. Per pod: with N
 *  replicas each one asks GitLab on its own. A constant, not an env var, on purpose: change it in
 *  code review. A user who is granted access waits up to the same time to see it. */
export const ACCESS_CACHE_TTL_MS = 5 * 60_000;
/** How long `unusable-login` and `unavailable` are remembered: long enough that a burst of requests
 *  does not hammer a GitLab that is down (or a refresh token that is dead), short enough that a fix
 *  (GitLab back, the user signed in again) shows within seconds. */
export const ACCESS_FAILURE_TTL_MS = 5_000;
const MAX_RETRY_AFTER_S = 60;
const SWEEP_ABOVE = 10_000;

/** Whether this ARC is checked at all. Always, by decision 1 of ADR 0002 (public ARCs too, because
 *  one can turn private after import). The one place to change if staging shows that GitLab refresh
 *  tokens expire so often that token callers break: then check only ARCs that are not public
 *  (needs a visibility known without the owner's login, e.g. stored at import) and serve the rest. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the fallback decides per ARC
function arcNeedsCheck(_arcId: number): boolean {
	return true;
}

const ALLOW: ArcAccess = { kind: 'allow' };
const DENY: ArcAccess = { kind: 'deny' };
const UNUSABLE: ArcAccess = { kind: 'unusable-login' };

const retryAfter = (res?: Response): number => {
	const seconds = Number(res?.headers.get('retry-after'));
	const floor = ACCESS_FAILURE_TTL_MS / 1000;
	return Number.isFinite(seconds) && seconds > 0
		? Math.min(Math.max(Math.ceil(seconds), floor), MAX_RETRY_AFTER_S)
		: floor;
};
const unavailable = (res?: Response): ArcAccess => ({
	kind: 'unavailable',
	retryAfterSeconds: retryAfter(res)
});
const isTransientStatus = (status: number) => status === 429 || status >= 500;

/** The project JSON, or undefined if the body is not what GitLab sends. Only `id` and `visibility`. */
async function readProject(
	res: Response
): Promise<{ id?: unknown; visibility?: unknown } | undefined> {
	try {
		const body: unknown = await res.json();
		return body && typeof body === 'object' ? body : undefined;
	} catch {
		return undefined;
	}
}

/** One GET /projects/:id, counted by whose credentials it used and what came back. A failed call (timeout,
 *  network) is counted as `error`. Labels are fixed names, never the ARC or the user. */
async function askGitlab(arcId: number, token?: string): Promise<Response> {
	const credentials = token ? 'user' : 'anonymous';
	try {
		const res = await fetchProjectForAccess(arcId, token);
		gitlabRequests.inc({ credentials, status_class: `${Math.floor(res.status / 100)}xx` });
		return res;
	} catch (e) {
		gitlabRequests.inc({ credentials, status_class: 'error' });
		throw e;
	}
}

/** Asks GitLab. Never throws: anything unexpected is `unavailable` (fail closed). Never logs a token
 *  or a response body. */
async function probe(userId: string, arcId: number): Promise<ArcAccess> {
	try {
		// 1. Anonymous: a public project is readable by anyone, and does not depend on this user's login.
		const anonymous = await askGitlab(arcId);
		if (isTransientStatus(anonymous.status)) return unavailable(anonymous);
		if (anonymous.status === 200) {
			const project = await readProject(anonymous);
			if (project?.id === arcId && project.visibility === 'public') return ALLOW;
		} else {
			await anonymous.body?.cancel();
		}

		// 2. Not public (or not provably so): the caller's own login decides.
		let token: string;
		try {
			token = await getWorkerAccessToken(userId);
		} catch (e) {
			if (e instanceof TokenError) return UNUSABLE;
			throw e; // lock wait timed out, database down: cannot tell
		}
		const res = await askGitlab(arcId, token);
		if (res.status === 200) {
			const project = await readProject(res);
			if (!project) return unavailable();
			// A project other than the one asked for must never open this ARC.
			return project.id === arcId ? ALLOW : DENY;
		}
		await res.body?.cancel();
		if (res.status === 404 || res.status === 403) return DENY;
		if (res.status === 401) return UNUSABLE; // GitLab no longer accepts the stored login
		if (!isTransientStatus(res.status)) {
			logger.error(`arc-access: unexpected PLANTdataHUB status ${res.status} for ARC ${arcId}`);
		}
		return unavailable(res);
	} catch (e) {
		logger.error(`arc-access: check failed: ${errorMessage(e)}`);
		return unavailable();
	}
}

interface Entry {
	result: ArcAccess;
	expiresAt: number;
}
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<ArcAccess>>();

/** Forgets every answer. For tests. */
export function resetArcAccessCache() {
	cache.clear();
	inflight.clear();
}

function fromEntry(entry: Entry, now: number): ArcAccess {
	// a remembered failure tells the client how long is left, not the original wait
	return entry.result.kind === 'unavailable'
		? {
				kind: 'unavailable',
				retryAfterSeconds: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000))
			}
		: entry.result;
}

/** Can this user read this ARC? Cached per (user, ARC), so one user's answer never serves another,
 *  and a token call and a session call of the same user share it. Concurrent callers for the same
 *  key share one GitLab round trip. The TTL runs from the moment the question was asked. */
export async function checkArcAccess(userId: string, arcId: number): Promise<ArcAccess> {
	if (!arcNeedsCheck(arcId)) return ALLOW;
	const key = JSON.stringify([userId, arcId]);
	const now = Date.now();

	const hit = cache.get(key);
	if (hit && hit.expiresAt > now) {
		const cached = fromEntry(hit, now);
		arcAccessCache.inc({ result: 'hit' });
		arcAccessOutcomes.inc({ outcome: outcomeName(cached) });
		return cached;
	}

	let pending = inflight.get(key);
	if (pending) {
		arcAccessCache.inc({ result: 'shared' });
	} else {
		arcAccessCache.inc({ result: 'miss' });
		pending = probe(userId, arcId)
			.then((result) => {
				if (cache.size > SWEEP_ABOVE) {
					for (const [k, e] of cache) if (e.expiresAt <= Date.now()) cache.delete(k);
				}
				const ttl =
					result.kind === 'allow' || result.kind === 'deny'
						? ACCESS_CACHE_TTL_MS
						: ACCESS_FAILURE_TTL_MS;
				cache.set(key, { result, expiresAt: now + ttl });
				return result;
			})
			.finally(() => inflight.delete(key));
		inflight.set(key, pending);
	}
	const result = await pending;
	// every caller counts its own answer, including the ones that shared a call
	arcAccessOutcomes.inc({ outcome: outcomeName(result) });
	return result;
}

/** The metric label of an answer: one of four fixed names. */
function outcomeName(access: ArcAccess): 'allow' | 'deny' | 'unusable_login' | 'unavailable' {
	return access.kind === 'unusable-login' ? 'unusable_login' : access.kind;
}

/** How a non-`allow` answer is shown to the client. The one place that decides the status codes, for
 *  BrAPI and for the ARC pages. `deny` is a 404, the same as for an unknown ARC, so the existence of
 *  an ARC is not revealed. */
export interface AccessFailure {
	status: 404 | 403 | 503;
	/** only for 403 and 503; a 404 uses the caller's own "unknown ARC" message */
	message?: string;
	retryAfterSeconds?: number;
}

export function accessFailure(access: ArcAccess): AccessFailure | undefined {
	switch (access.kind) {
		case 'allow':
			return undefined;
		case 'deny':
			return { status: 404 };
		case 'unusable-login':
			return {
				status: 403,
				message:
					'Your PLANTdataHUB login can no longer be used to check your access to this ARC. Sign in to MIRA again in a browser, then retry.'
			};
		case 'unavailable':
			return {
				status: 503,
				message:
					'Access to this ARC could not be checked because PLANTdataHUB did not answer. Try again shortly.',
				retryAfterSeconds: access.retryAfterSeconds
			};
	}
}

/** Whether the user's stored PLANTdataHUB login still works, for `/account/tokens`. Goes through the
 *  same refresh path as an access check (one refresh at most, under the lock), but asks GitLab
 *  nothing else. */
export async function loginStatus(userId: string): Promise<'ok' | 'sign-in-again' | 'unknown'> {
	try {
		await getWorkerAccessToken(userId);
		return 'ok';
	} catch (e) {
		return e instanceof TokenError ? 'sign-in-again' : 'unknown';
	}
}
