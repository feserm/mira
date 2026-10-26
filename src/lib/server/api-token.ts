/** API tokens for the BrAPI endpoints (docs/adr/0001-api-tokens.md). Web app only: it is not imported
 *  by `auth-options.ts`, which the ETL worker bundles. Plaintext tokens are returned once by
 *  `createApiToken` and never stored, logged or echoed; the table holds the SHA-256 hash. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { apiToken, user } from '$lib/server/db/schema';

export const TOKEN_PREFIX = 'mira_';
/** `mira_` plus 32 random bytes as base64url (43 characters). Checked before any database lookup. */
export const TOKEN_PATTERN = /^mira_[A-Za-z0-9_-]{43}$/;
const DISPLAY_PREFIX_LENGTH = 8;

/** Allowed lifetimes in days; `null` is "never expires" and must be chosen explicitly. */
export const EXPIRY_CHOICES = [30, 90, 365, null] as const;
export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_ACTIVE_TOKENS_PER_USER = 25;
const DAY_MS = 86_400_000;

/** A random token has 256 bits of entropy, so a fast hash is enough: there is nothing to brute-force. */
export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
	return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export interface ApiTokenInfo {
	id: string;
	name: string;
	prefix: string;
	createdAt: Date;
	expiresAt: Date | null;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
}

const infoColumns = {
	id: apiToken.id,
	name: apiToken.name,
	prefix: apiToken.prefix,
	createdAt: apiToken.createdAt,
	expiresAt: apiToken.expiresAt,
	lastUsedAt: apiToken.lastUsedAt,
	revokedAt: apiToken.revokedAt
};

/** Creates a token for `userId`. The returned `token` is the only time the secret exists in plaintext. */
export async function createApiToken(
	userId: string,
	name: string,
	expiresInDays: number | null,
	now = new Date()
): Promise<{ token: string; info: ApiTokenInfo }> {
	const token = generateToken();
	const [info] = await db
		.insert(apiToken)
		.values({
			userId,
			name,
			tokenHash: hashToken(token),
			prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
			createdAt: now,
			expiresAt: expiresInDays === null ? null : new Date(now.getTime() + expiresInDays * DAY_MS)
		})
		.returning(infoColumns);
	return { token, info };
}

/** The user's own tokens, newest first, including revoked and expired ones. */
export function listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
	return db
		.select(infoColumns)
		.from(apiToken)
		.where(eq(apiToken.userId, userId))
		.orderBy(desc(apiToken.createdAt));
}

export async function countActiveTokens(userId: string, now = new Date()): Promise<number> {
	const rows = await listApiTokens(userId);
	return rows.filter((t) => tokenStatus(t, now) === 'active').length;
}

/** Revokes one of the user's tokens. False if it does not exist or belongs to someone else. */
export async function revokeApiToken(
	userId: string,
	id: string,
	now = new Date()
): Promise<boolean> {
	const rows = await db
		.update(apiToken)
		.set({ revokedAt: now })
		.where(and(eq(apiToken.id, id), eq(apiToken.userId, userId)))
		.returning({ id: apiToken.id });
	return rows.length > 0;
}

export function tokenStatus(
	t: Pick<ApiTokenInfo, 'expiresAt' | 'revokedAt'>,
	now = new Date()
): 'active' | 'revoked' | 'expired' {
	if (t.revokedAt) return 'revoked';
	if (t.expiresAt && t.expiresAt.getTime() <= now.getTime()) return 'expired';
	return 'active';
}

export type VerifiedToken = {
	tokenId: string;
	lastUsedAt: Date | null;
	user: typeof user.$inferSelect;
};

/** Looks up a presented token. Undefined for anything that is not an active token of a user who is not
 *  banned. The caller is expected to have checked `TOKEN_PATTERN` already. */
export async function verifyApiToken(
	token: string,
	now = new Date()
): Promise<VerifiedToken | undefined> {
	const hash = hashToken(token);
	const [row] = await db
		.select({
			tokenId: apiToken.id,
			tokenHash: apiToken.tokenHash,
			expiresAt: apiToken.expiresAt,
			revokedAt: apiToken.revokedAt,
			lastUsedAt: apiToken.lastUsedAt,
			user
		})
		.from(apiToken)
		.innerJoin(user, eq(user.id, apiToken.userId))
		.where(eq(apiToken.tokenHash, hash));
	if (!row) return undefined;

	const a = Buffer.from(row.tokenHash);
	const b = Buffer.from(hash);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
	if (tokenStatus(row, now) !== 'active') return undefined;
	if (row.user.banned && (!row.user.banExpires || row.user.banExpires.getTime() > now.getTime()))
		return undefined;

	return { tokenId: row.tokenId, lastUsedAt: row.lastUsedAt, user: row.user };
}

/** Records use without delaying or failing the request: at most one write per token per
 *  `intervalMs`, fire and forget, errors logged without the token. */
const writing = new Set<string>();
export const LAST_USED_INTERVAL_MS = 5 * 60_000;

export function touchLastUsed(
	token: Pick<VerifiedToken, 'tokenId' | 'lastUsedAt'>,
	now = new Date()
): void {
	if (token.lastUsedAt && now.getTime() - token.lastUsedAt.getTime() < LAST_USED_INTERVAL_MS)
		return;
	if (writing.has(token.tokenId)) return;
	writing.add(token.tokenId);
	void (async () => {
		try {
			await db.update(apiToken).set({ lastUsedAt: now }).where(eq(apiToken.id, token.tokenId));
		} catch (e) {
			console.error(
				`Could not record last use of API token ${token.tokenId}:`,
				e instanceof Error ? e.message : 'unknown error'
			);
		} finally {
			writing.delete(token.tokenId);
		}
	})();
}
