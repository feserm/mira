import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { config } from '$lib/server/env';

const { poolMax, idleTimeoutSeconds, connectTimeoutSeconds, ssl } = config.db;

const client = postgres(config.databaseUrl, {
	max: poolMax,
	idle_timeout: idleTimeoutSeconds,
	connect_timeout: connectTimeoutSeconds,
	ssl
});

export const db = drizzle(client, { schema });

/** Waits up to `timeoutSeconds` for in-flight queries, then closes every pooled connection. */
export function closeDb(timeoutSeconds = 5): Promise<void> {
	return client.end({ timeout: timeoutSeconds });
}
