/**
 * The ETL worker: claims jobs from the `etl_job` table and runs the Extract/Transform/Load pipeline.
 * Same image as the web app, started with `node worker.js`. Bundled by `pnpm build:worker` into
 * build-worker/worker.js with `$lib` and the two SvelteKit env modules aliased (vite.worker.config.ts).
 *
 * It needs the web app's configuration (DATABASE_URL, ORIGIN, BETTER_AUTH_SECRET, OIDC_*) because it
 * refreshes the importing user's PLANTdataHUB token through better-auth, plus the optional ETL_* and
 * HTTP_* settings. An invalid configuration aborts at start-up with one readable error (src/lib/server/env.ts).
 * Design and failure modes: docs/etl-worker.md.
 */
import { hostname } from 'node:os';
import { config } from '$lib/server/env';
import { closeDb, db } from '$lib/server/db';
import { executeJob } from '$lib/server/etl/execute';
import { startRunner } from '$lib/server/etl/runner';
import { getWorkerAccessToken } from '$lib/server/etl/worker-auth';

const workerId = `${hostname()}-${process.pid}`;
const { etl } = config;

if (config.db.poolMax < etl.concurrency + 1) {
	console.warn(
		`etl: DB_POOL_MAX (${config.db.poolMax}) is below ETL_CONCURRENCY + 1 (${etl.concurrency + 1}); jobs may wait for a connection`
	);
}

const runner = startRunner({
	db,
	workerId,
	concurrency: etl.concurrency,
	leaseSeconds: etl.leaseSeconds,
	pollSeconds: etl.pollSeconds,
	retryDelaySeconds: etl.retryDelaySeconds,
	shutdownTimeoutSeconds: etl.shutdownTimeoutSeconds,
	execute: (job, beginStep) =>
		executeJob(job.kind, job.arcId, {
			userId: job.requestedBy,
			getToken: () => getWorkerAccessToken(job.requestedBy),
			beginStep
		}),
	// No HTTP port, so no liveness probe: if the database stays unreachable, exit non-zero and let the
	// kubelet restart the pod.
	onFatal: (reason) => {
		console.error(`etl: giving up: ${reason}`);
		process.exit(1);
	}
});

console.log(
	`etl: worker ${workerId} started (concurrency ${etl.concurrency}, lease ${etl.leaseSeconds}s, poll ${etl.pollSeconds}s)`
);

let shuttingDown = false;
async function shutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`etl: ${signal} received, no longer claiming jobs`);
	await runner.stop();
	await closeDb(5).catch(() => {});
	console.log('etl: stopped');
	process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
