import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { account } from '$lib/server/db/schema';
import { config } from '$lib/server/env';
import { FetchTimeoutError } from '$lib/server/fetch-timeout';

/** GitLab refresh tokens are single use: a refresh returns a new one and invalidates the old. Two
 *  callers (two web requests, or the web app and a worker) that refresh the same user's token at
 *  once both send the old refresh token; the loser gets `invalid_grant` and the user is told to sign
 *  in again. So the refresh is serialised per user with a Postgres advisory lock, shared by the web
 *  app (`plantdatahub-token.ts`) and the worker (`etl/worker-auth.ts`).
 *
 *  Inside the lock the caller re-reads the account row (better-auth does, on every call), so the
 *  second caller finds the token the first one just stored and does not refresh again.
 *
 *  Pool safety: the lock is `pg_advisory_xact_lock` inside a transaction, so it holds one pool
 *  connection for as long as the refresh runs, and the refresh itself needs a second one. At most
 *  half of `DB_POOL_MAX` locks may be held or awaited at once per process (`slots`); the rest queue
 *  in memory without a connection. A transaction-scoped lock is released by Postgres if the process
 *  dies, and is safe behind PgBouncer in transaction mode (a session-level lock is not). */

/** How long to wait for another refresh of the same user to finish. */
export const REFRESH_LOCK_WAIT_MS = 30_000;
/** better-auth refreshes an access token that expires within 5 s. A token valid for longer than this
 *  margin is not refreshed by the call that follows, so it needs no lock. */
const SKIP_LOCK_IF_VALID_FOR_MS = 30_000;
/** Postgres SQLSTATE `lock_not_available`; `isTransient` (etl/errors.ts) retries it. */
export const LOCK_NOT_AVAILABLE = '55P03';

/** The advisory lock's name for a user. */
export const refreshLockName = (userId: string) => `mira:oidc-refresh:${userId}`;

export class RefreshLockTimeoutError extends Error {
	readonly code = LOCK_NOT_AVAILABLE;
	constructor(waitMs = REFRESH_LOCK_WAIT_MS) {
		super(
			`another refresh of this user's PLANTdataHUB token did not finish within ${waitMs / 1000}s`
		);
		this.name = 'RefreshLockTimeoutError';
	}
}

// Counting semaphore: how many locks this process holds or waits for at once.
let held = 0;
const queue: (() => void)[] = [];
const maxHeld = () => Math.max(1, Math.floor(config.db.poolMax / 2));

async function acquireSlot() {
	if (held < maxHeld()) {
		held++;
		return;
	}
	await new Promise<void>((resolve) => queue.push(resolve)); // the slot is handed over, `held` unchanged
}

function releaseSlot() {
	const next = queue.shift();
	if (next) next();
	else held--;
}

async function needsRefresh(userId: string, accountId: string): Promise<boolean> {
	const [row] = await db
		.select({ expiresAt: account.accessTokenExpiresAt })
		.from(account)
		.where(and(eq(account.userId, userId), eq(account.accountId, accountId)))
		.limit(1);
	if (!row?.expiresAt) return false;
	return row.expiresAt.getTime() - Date.now() < SKIP_LOCK_IF_VALID_FOR_MS;
}

/** Runs `getToken` (the better-auth `getAccessToken` call, which refreshes when needed) so that two
 *  refreshes of one user never overlap. Fast path: no lock while the stored token is comfortably
 *  valid. `getToken` is also bounded by `HTTP_TIMEOUT`, because better-auth's own fetches to the
 *  issuer have no timeout and a hung one would hold the lock. */
export async function withRefreshLock<T>(
	userId: string,
	accountId: string,
	getToken: () => Promise<T>,
	waitMs = REFRESH_LOCK_WAIT_MS
): Promise<T> {
	if (!(await needsRefresh(userId, accountId))) return getToken();

	await acquireSlot();
	try {
		return await db.transaction(async (tx) => {
			await tx.execute(sql`select set_config('lock_timeout', ${`${waitMs}ms`}, true)`);
			try {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtextextended(${refreshLockName(userId)}, 0))`
				);
			} catch (e) {
				// drizzle wraps driver errors; the SQLSTATE is on the error or its cause
				const err = e as { code?: string; cause?: { code?: string } };
				if (err.code === LOCK_NOT_AVAILABLE || err.cause?.code === LOCK_NOT_AVAILABLE) {
					throw new RefreshLockTimeoutError(waitMs);
				}
				throw e;
			}
			return boundedByHttpTimeout(getToken());
		});
	} finally {
		releaseSlot();
	}
}

async function boundedByHttpTimeout<T>(work: Promise<T>): Promise<T> {
	const limitMs = config.http.totalTimeoutSeconds * 1000;
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new FetchTimeoutError('total', limitMs, 'the OIDC issuer')),
					limitMs
				);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}
