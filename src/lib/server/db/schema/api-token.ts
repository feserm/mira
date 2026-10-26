import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth/schema';

/** Per-user API tokens for the BrAPI endpoints (S2.4, docs/adr/0001-api-tokens.md). Only the SHA-256
 *  hash of the secret is stored; `prefix` is the first characters of the token, shown in the UI so a
 *  user can tell their tokens apart. Not a better-auth table: do not move it into `auth/`. */
export const apiToken = pgTable(
	'api_token',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		tokenHash: text('token_hash').notNull().unique(),
		prefix: text('prefix').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
		revokedAt: timestamp('revoked_at', { withTimezone: true })
	},
	(table) => [index('api_token_user_id_idx').on(table.userId)]
);
