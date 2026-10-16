/** The worker's claim/heartbeat/finish loop, kept apart from the pipeline (`execute` is injected) and
 *  from env/SvelteKit so it can be tested against a real database with a fake pipeline. Behaviour and
 *  failure modes: docs/etl-worker.md. */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { EtlJob } from '$lib/server/db/schema';
import { errorMessage, isTransient } from './errors';
import * as queue from './queue';
import type { JobClaim, JobStep } from './queue';

type Db = PostgresJsDatabase<Record<string, unknown>>;

export type JobOutcome =
	{ ok: true } | { ok: false; lost: true } | { ok: false; error: string; transient: boolean };

export interface RunnerOptions {
	db: Db;
	workerId: string;
	concurrency: number;
	leaseSeconds: number;
	pollSeconds: number;
	retryDelaySeconds: number;
	shutdownTimeoutSeconds: number;
	/** Runs the job. `beginStep` records progress and returns false once the claim is lost. */
	execute: (job: EtlJob, beginStep: (step: JobStep) => Promise<boolean>) => Promise<JobOutcome>;
	log?: (line: string) => void;
	/** Called after this many failed polls in a row (database unreachable). */
	maxConsecutivePollFailures?: number;
	onFatal?: (reason: string) => void;
}

export interface Runner {
	/** Resolves when `stop()` has finished. */
	done: Promise<void>;
	stop(): Promise<void>;
}

interface Active {
	claim: JobClaim;
	job: EtlJob;
	finished: Promise<void>;
}

export function startRunner(opts: RunnerOptions): Runner {
	const log = opts.log ?? ((line) => console.log(line));
	const maxPollFailures = opts.maxConsecutivePollFailures ?? 10;
	const active = new Map<string, Active>();
	let stopping = false;
	const wakers = new Set<() => void>();
	let pollFailures = 0;

	const describe = (job: EtlJob) =>
		`job=${job.id} arc=${job.arcId} kind=${job.kind} attempt=${job.attempts}/${job.maxAttempts}`;

	const sleep = (seconds: number) =>
		new Promise<void>((resolve) => {
			const wakeUp = () => {
				clearTimeout(timer);
				wakers.delete(wakeUp);
				resolve();
			};
			const timer = setTimeout(wakeUp, seconds * 1000);
			wakers.add(wakeUp);
		});

	async function runJob(job: EtlJob): Promise<void> {
		const claim: JobClaim = {
			id: job.id,
			arcId: job.arcId,
			attempts: job.attempts,
			workerId: opts.workerId
		};
		let lost = false;
		const heartbeat = setInterval(
			async () => {
				try {
					if (!(await queue.heartbeat(opts.db, claim, opts.leaseSeconds))) {
						lost = true;
						log(`etl: ${describe(job)} lost its claim (reclaimed or finished elsewhere)`);
					}
				} catch (e) {
					// Database blip: keep trying. If it lasts longer than the lease, the job is reclaimed.
					log(`etl: ${describe(job)} heartbeat failed: ${errorMessage(e)}`);
				}
			},
			(opts.leaseSeconds / 3) * 1000
		);

		const started = Date.now();
		log(`etl: ${describe(job)} running`);
		try {
			const beginStep = async (step: JobStep) => {
				if (lost || !(await queue.setStep(opts.db, claim, step))) {
					lost = true;
					return false;
				}
				log(`etl: ${describe(job)} step=${step}`);
				return true;
			};

			let outcome: JobOutcome;
			try {
				outcome = await opts.execute(job, beginStep);
			} catch (e) {
				// The pipeline records step failures itself; this is something unexpected (e.g. the
				// database went away while it was writing the status).
				outcome = { ok: false, error: errorMessage(e), transient: isTransient(e) };
			}

			const seconds = ((Date.now() - started) / 1000).toFixed(1);
			if (outcome.ok) {
				const done = await queue.complete(opts.db, claim);
				log(
					done
						? `etl: ${describe(job)} succeeded in ${seconds}s`
						: `etl: ${describe(job)} finished but its claim was lost`
				);
			} else if ('lost' in outcome) {
				log(`etl: ${describe(job)} abandoned: claim lost after ${seconds}s`);
			} else {
				const result = await queue.fail(opts.db, claim, outcome.error, {
					transient: outcome.transient,
					retryDelaySeconds: opts.retryDelaySeconds
				});
				log(
					`etl: ${describe(job)} ${result === 'retry' ? 'failed, will retry' : result} after ${seconds}s: ${outcome.error}`
				);
			}
		} finally {
			clearInterval(heartbeat);
		}
	}

	async function slot(): Promise<void> {
		while (!stopping) {
			let job: EtlJob | undefined;
			try {
				for (const reaped of await queue.reapExpired(opts.db)) {
					log(`etl: ${describe(reaped)} failed: worker lost`);
				}
				job = await queue.claim(opts.db, opts.workerId, opts.leaseSeconds);
				pollFailures = 0;
			} catch (e) {
				log(`etl: poll failed: ${errorMessage(e)}`);
				if (++pollFailures >= maxPollFailures) {
					opts.onFatal?.(`${pollFailures} consecutive failed polls`);
					return;
				}
			}
			if (!job) {
				await sleep(opts.pollSeconds);
				continue;
			}
			const claimed = job;
			const entry: Active = {
				claim: {
					id: claimed.id,
					arcId: claimed.arcId,
					attempts: claimed.attempts,
					workerId: opts.workerId
				},
				job: claimed,
				finished: runJob(claimed)
					.catch((e) => log(`etl: ${describe(claimed)} error: ${errorMessage(e)}`))
					.finally(() => active.delete(claimed.id))
			};
			active.set(claimed.id, entry);
			await entry.finished;
		}
	}

	const slots = Array.from({ length: opts.concurrency }, () => slot());
	const all = Promise.all(slots).then(() => undefined);

	async function stop(): Promise<void> {
		if (stopping) return all;
		stopping = true;
		for (const wakeUp of [...wakers]) wakeUp();
		log(
			`etl: stopping, waiting up to ${opts.shutdownTimeoutSeconds}s for ${active.size} running job(s)`
		);
		let timer: NodeJS.Timeout | undefined;
		const timedOut = await Promise.race([
			all.then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), opts.shutdownTimeoutSeconds * 1000);
			})
		]);
		clearTimeout(timer);

		if (timedOut) {
			// Hand the unfinished jobs back so another worker starts them at once, instead of leaving
			// them "running" until the lease expires.
			for (const { claim, job } of active.values()) {
				const released = await queue
					.release(
						opts.db,
						claim,
						'The worker was shut down during the import; it was queued again.'
					)
					.catch(() => false);
				log(
					`etl: ${describe(job)} ${released ? 'released back to the queue' : 'could not be released'}`
				);
			}
		}
	}

	return { done: all, stop };
}
