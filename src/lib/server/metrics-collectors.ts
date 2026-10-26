/** Scrape-time metrics that need the database: the ETL queue, the connection pool. Registered when this
 *  module is imported (by the /metrics route). The worker serves no port, so the queue's state is
 *  read from `etl_job` by the web pods; every pod reports the same numbers (use `max` in Prometheus).
 *
 *  Runs as the DML role: three reads of `etl_job` and one of `pg_stat_activity` (rows of the same role
 *  are visible to it). Nothing here reads an ARC, a user or a repo name. */
import { sql } from 'drizzle-orm';
import { config } from '$lib/server/env';
import { applicationName, db } from '$lib/server/db';
import {
	dbPing,
	dbPoolMax,
	dbPoolOpen,
	etlJobSeconds,
	etlJobsFinished,
	etlJobsInState,
	etlOldestQueued,
	registry
} from '$lib/server/metrics';

const QUERY_TIMEOUT_MS = 2000;

function bounded<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('timeout')), QUERY_TIMEOUT_MS);
		})
	]).finally(() => clearTimeout(timer));
}

const STATES = ['queued', 'running', 'succeeded', 'failed'] as const;

registry.collect('database', async () => {
	dbPoolMax.set(config.db.poolMax);

	const started = performance.now();
	const open = await bounded(
		db.execute<{ n: number }>(
			sql`select count(*)::int as n from pg_stat_activity where application_name = ${applicationName}`
		)
	);
	dbPing.set((performance.now() - started) / 1000);
	dbPoolOpen.set(Number(open[0]?.n ?? 0));
});

registry.collect('etl-queue', async () => {
	const [counts, durations, oldest] = await bounded(
		Promise.all([
			db.execute<{ state: string; n: number }>(
				sql`select state::text as state, count(*)::int as n from etl_job group by state`
			),
			db.execute<{ state: string; seconds: number }>(
				sql`select state::text as state,
					coalesce(sum(extract(epoch from finished_at - started_at)), 0)::float8 as seconds
					from etl_job where state in ('succeeded', 'failed') and started_at is not null and finished_at is not null
					group by state`
			),
			db.execute<{ age: number }>(
				sql`select coalesce(extract(epoch from now() - min(run_after)), 0)::float8 as age
					from etl_job where state = 'queued' and run_after <= now()`
			)
		])
	);

	const byState = new Map(counts.map((r) => [r.state, Number(r.n)]));
	const seconds = new Map(durations.map((r) => [r.state, Number(r.seconds)]));
	for (const state of STATES) {
		const n = byState.get(state) ?? 0;
		if (state === 'queued' || state === 'running') etlJobsInState.set({ state }, n);
		else {
			etlJobsFinished.set({ state }, n);
			etlJobSeconds.set({ state }, seconds.get(state) ?? 0);
		}
	}
	etlOldestQueued.set(Math.max(0, Number(oldest[0]?.age ?? 0)));
});
