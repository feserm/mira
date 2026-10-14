import { index, integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const requestLogs = pgTable(
	'request_logs',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		endpoint: text('endpoint').notNull(),
		method: text('method').notNull(),
		responseTimeMs: real('response_time_ms').notNull(),
		status: integer('status').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		index('request_logs_created_at_idx').on(table.createdAt),
		index('request_logs_endpoint_created_at_idx').on(table.endpoint, table.createdAt)
	]
);
