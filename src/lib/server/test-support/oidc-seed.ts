/** Gives a user the stored, encrypted PLANTdataHUB login better-auth keeps in `account`, the way a real
 *  sign-in leaves it. Needs `$lib/server/env` mocked with `env-mock.ts` (same secret). */
import { symmetricEncrypt } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { account, user } from '$lib/server/db/schema';
import type { AppDb } from './dml-db';
import { TEST_AUTH_SECRET } from './env-mock';

export async function seedUser(db: AppDb, id: string) {
	await db
		.insert(user)
		.values({ id, name: id, email: `${id}@example.org` })
		.onConflictDoNothing();
}

export async function seedOidcLogin(
	db: AppDb,
	userId: string,
	opts: { accessToken: string; refreshToken?: string; expiresInMs?: number }
) {
	await seedUser(db, userId);
	await db.delete(account).where(eq(account.userId, userId));
	await db.insert(account).values({
		id: `acc-${userId}`,
		accountId: `gl-${userId}`,
		providerId: 'oidc',
		userId,
		accessToken: await symmetricEncrypt({ key: TEST_AUTH_SECRET, data: opts.accessToken }),
		refreshToken: await symmetricEncrypt({
			key: TEST_AUTH_SECRET,
			data: opts.refreshToken ?? 'glrt-initial'
		}),
		accessTokenExpiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000))
	});
}
