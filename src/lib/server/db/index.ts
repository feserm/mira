import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { config } from '$lib/server/env';

const { poolMax, idleTimeoutSeconds, connectTimeoutSeconds, ssl, prepare } = config.db;

/** Names this process's connections in pg_stat_activity, so `/metrics` can count the ones this pod holds
 *  (the pod name is the hostname; web and worker pods differ). Postgres cuts it at 63 characters. */
export const applicationName = `mira-${process.env.HOSTNAME || 'local'}`.slice(0, 63);

const client = postgres(config.databaseUrl, {
	connection: { application_name: applicationName },
	max: poolMax,
	idle_timeout: idleTimeoutSeconds,
	connect_timeout: connectTimeoutSeconds,
	ssl,
	prepare
});

export const db = drizzle(client, { schema });

/** Waits up to `timeoutSeconds` for in-flight queries, then closes every pooled connection. */
export function closeDb(timeoutSeconds = 5): Promise<void> {
	return client.end({ timeout: timeoutSeconds });
}
