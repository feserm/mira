import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { account } from '$lib/server/db/schema';

/** The user's most recently linked 'oidc' account id, or undefined. A user can accumulate more than
 *  one linked 'oidc' account row (e.g. GitLab returning a different subject claim across logins).
 *  Without an explicit accountId, better-auth's own account lookup isn't ordered by recency and can
 *  select a stale row, so pick the most recently linked one ourselves. Shared by the web app and the
 *  ETL worker so both use the same account. */
export async function findOidcAccountId(userId: string): Promise<string | undefined> {
	const [oidcAccount] = await db
		.select({ accountId: account.accountId })
		.from(account)
		.where(and(eq(account.userId, userId), eq(account.providerId, 'oidc')))
		.orderBy(desc(account.updatedAt))
		.limit(1);
	return oidcAccount?.accountId;
}
