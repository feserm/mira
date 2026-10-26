import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { apiToken } from '$lib/server/db/schema';
import { useTestDb } from '$lib/server/test-support/db-mock';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import {
	createApiToken,
	hashToken,
	LAST_USED_INTERVAL_MS,
	listApiTokens,
	revokeApiToken,
	TOKEN_PATTERN,
	touchLastUsed,
	verifyApiToken
} from './api-token';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);

const DAY = 86_400_000;

async function eventually(check: () => Promise<boolean>) {
	for (let i = 0; i < 50; i++) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error('condition not met');
}

describe.skipIf(!hasTestDb)('API tokens (real Postgres, DML-only role)', () => {
	let t: DmlTestDb;
	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});

	it('returns the secret once and stores only its hash', async () => {
		const { token, info } = await createApiToken(t.userId, 'notebook', 90);
		expect(token).toMatch(TOKEN_PATTERN);

		const rows = await t.client`select * from api_token where id = ${info.id}`;
		expect(rows).toHaveLength(1);
		expect(rows[0].token_hash).toBe(hashToken(token));
		expect(rows[0].prefix).toBe(token.slice(0, 8));
		// the plaintext is in no column of the row, nor in anything the listing returns
		expect(JSON.stringify(rows[0])).not.toContain(token);
		expect(JSON.stringify(await listApiTokens(t.userId))).not.toContain(token);
		expect(info).not.toHaveProperty('tokenHash');
	});

	it('makes every token different and expiry follows the chosen lifetime', async () => {
		const now = new Date('2030-01-01T00:00:00Z');
		const a = await createApiToken(t.userId, 'a', 30, now);
		const b = await createApiToken(t.userId, 'b', null, now);
		expect(a.token).not.toBe(b.token);
		expect(a.info.expiresAt).toEqual(new Date(now.getTime() + 30 * DAY));
		expect(b.info.expiresAt).toBeNull();
	});

	it('verifies a valid token and rejects unknown, revoked, expired and banned-owner tokens', async () => {
		const now = new Date('2030-06-01T00:00:00Z');
		const ok = await createApiToken(t.userId, 'ok', 30, now);
		expect((await verifyApiToken(ok.token, now))?.user.id).toBe(t.userId);
		expect(await verifyApiToken('mira_' + 'A'.repeat(43), now)).toBeUndefined();

		// expiry honours the clock: valid the second before, invalid at the expiry instant
		const expiry = ok.info.expiresAt!;
		expect(await verifyApiToken(ok.token, new Date(expiry.getTime() - 1000))).toBeDefined();
		expect(await verifyApiToken(ok.token, expiry)).toBeUndefined();

		const revoked = await createApiToken(t.userId, 'revoked', null, now);
		expect(await revokeApiToken(t.userId, revoked.info.id, now)).toBe(true);
		expect(await verifyApiToken(revoked.token, now)).toBeUndefined();

		await t.client`update "user" set banned = true where id = ${t.userId}`;
		expect(await verifyApiToken(ok.token, now)).toBeUndefined();
		await t.client`update "user" set banned = false where id = ${t.userId}`;
		expect(await verifyApiToken(ok.token, now)).toBeDefined();
	});

	it('lists and revokes only the caller’s own tokens', async () => {
		const other = `u-other-${Math.random().toString(36).slice(2)}`;
		await t.client`insert into "user" (id, name, email) values (${other}, 'O', ${other + '@example.org'})`;
		const mine = await createApiToken(t.userId, 'mine', 30);
		const theirs = await createApiToken(other, 'theirs', 30);

		const names = (await listApiTokens(t.userId)).map((x) => x.name);
		expect(names).toContain('mine');
		expect(names).not.toContain('theirs');

		expect(await revokeApiToken(t.userId, theirs.info.id)).toBe(false);
		expect(await verifyApiToken(theirs.token)).toBeDefined();
		expect(await revokeApiToken(other, theirs.info.id)).toBe(true);
		expect(await revokeApiToken(t.userId, mine.info.id)).toBe(true);
	});

	it('records last use at most once per interval, and a failing write is swallowed', async () => {
		const { info } = await createApiToken(t.userId, 'used', 30);
		const t0 = new Date('2031-01-01T00:00:00Z');
		touchLastUsed({ tokenId: info.id, lastUsedAt: null }, t0);
		await eventually(async () => {
			const [r] = await t.db.select().from(apiToken).where(eq(apiToken.id, info.id));
			return r.lastUsedAt?.getTime() === t0.getTime();
		});

		// within the interval: no write, so the stored time stays at t0
		touchLastUsed(
			{ tokenId: info.id, lastUsedAt: t0 },
			new Date(t0.getTime() + LAST_USED_INTERVAL_MS - 1)
		);
		await new Promise((r) => setTimeout(r, 100));
		const [r] = await t.db.select().from(apiToken).where(eq(apiToken.id, info.id));
		expect(r.lastUsedAt).toEqual(t0);

		// a database error neither throws nor leaks
		const err = vi.spyOn(console, 'log').mockImplementation(() => {});
		const spy = vi.spyOn(t.db, 'update').mockImplementation(() => {
			throw new Error('db down');
		});
		expect(() => touchLastUsed({ tokenId: info.id, lastUsedAt: null })).not.toThrow();
		await eventually(async () => err.mock.calls.length > 0);
		spy.mockRestore();
		err.mockRestore();
	});
});
