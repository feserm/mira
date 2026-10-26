/** The worker's claim/heartbeat/finish loop, kept apart from the pipeline (`execute` is injected) and
 *  from env/SvelteKit so it can be tested against a real database with a fake pipeline. Behaviour and
 *  failure modes: docs/etl-worker.md. */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { EtlJob } from '$lib/server/db/schema';
import { errorMessage, isTransient } from './errors';
import { logger, type LogFields, type LogLevel } from '$lib/server/log';
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
	/** One call per event: the message (as in docs/etl-worker.md) and its structured fields. The default
	 *  writes a JSON line through the shared logger; a test passes its own. `level` is not a field of
	 *  the line, it picks the severity (default info). */
	log?: (line: string, fields?: LogFields & { level?: LogLevel }) => void;
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
	const log =
		opts.log ??
		((line: string, { level = 'info', ...fields }: LogFields & { level?: LogLevel } = {}) =>
			logger[level](line, fields));
	const maxPollFailures = opts.maxConsecutivePollFailures ?? 10;
	const active = new Map<string, Active>();
	let stopping = false;
	const wakers = new Set<() => void>();
	let pollFailures = 0;

	const describe = (job: EtlJob) =>
		`job=${job.id} arc=${job.arcId} kind=${job.kind} attempt=${job.attempts}/${job.maxAttempts}`;
	/** What identifies a job in a structured line; `jobId` plays the part of the web app's request id. */
	const jobFields = (job: EtlJob): LogFields => ({
		jobId: job.id,
		arcId: job.arcId,
		kind: job.kind,
		attempt: job.attempts,
		maxAttempts: job.maxAttempts,
		workerId: opts.workerId
	});

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
						log(`etl: ${describe(job)} lost its claim (reclaimed or finished elsewhere)`, {
							...jobFields(job),
							event: 'etl.claim_lost',
							level: 'warn'
						});
					}
				} catch (e) {
					// Database blip: keep trying. If it lasts longer than the lease, the job is reclaimed.
					log(`etl: ${describe(job)} heartbeat failed: ${errorMessage(e)}`, {
						...jobFields(job),
						event: 'etl.heartbeat_failed',
						level: 'warn'
					});
				}
			},
			(opts.leaseSeconds / 3) * 1000
		);

		const started = Date.now();
		let current: { step: JobStep; startedAt: number } | undefined;
		/** Ends the running step; the duration goes on the next line written. */
		const closeStep = () => {
			const done = current && { step: current.step, ms: Date.now() - current.startedAt };
			current = undefined;
			return done;
		};
		log(`etl: ${describe(job)} running`, {
			...jobFields(job),
			event: 'etl.job',
			outcome: 'running'
		});
		try {
			const beginStep = async (step: JobStep) => {
				if (lost || !(await queue.setStep(opts.db, claim, step))) {
					lost = true;
					return false;
				}
				const previous = closeStep();
				current = { step, startedAt: Date.now() };
				log(`etl: ${describe(job)} step=${step}`, {
					...jobFields(job),
					event: 'etl.step',
					step,
					previousStep: previous?.step,
					previousStepMs: previous?.ms
				});
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
			const last = closeStep();
			const ended = {
				...jobFields(job),
				event: 'etl.job',
				durationMs: Date.now() - started,
				lastStep: last?.step,
				lastStepMs: last?.ms
			};
			if (outcome.ok) {
				const done = await queue.complete(opts.db, claim);
				log(
					done
						? `etl: ${describe(job)} succeeded in ${seconds}s`
						: `etl: ${describe(job)} finished but its claim was lost`,
					{ ...ended, outcome: done ? 'succeeded' : 'claim_lost', level: done ? 'info' : 'warn' }
				);
			} else if ('lost' in outcome) {
				log(`etl: ${describe(job)} abandoned: claim lost after ${seconds}s`, {
					...ended,
					outcome: 'claim_lost',
					level: 'warn'
				});
			} else {
				const result = await queue.fail(opts.db, claim, outcome.error, {
					transient: outcome.transient,
					retryDelaySeconds: opts.retryDelaySeconds
				});
				log(
					`etl: ${describe(job)} ${result === 'retry' ? 'failed, will retry' : result} after ${seconds}s: ${outcome.error}`,
					{
						...ended,
						outcome: result === 'retry' ? 'retry' : result,
						transient: outcome.transient,
						level: result === 'retry' ? 'warn' : 'error'
					}
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
					log(`etl: ${describe(reaped)} failed: worker lost`, {
						...jobFields(reaped),
						event: 'etl.job',
						outcome: 'worker_lost',
						level: 'error'
					});
				}
				job = await queue.claim(opts.db, opts.workerId, opts.leaseSeconds);
				pollFailures = 0;
			} catch (e) {
				log(`etl: poll failed: ${errorMessage(e)}`, {
					event: 'etl.poll_failed',
					workerId: opts.workerId,
					consecutiveFailures: pollFailures + 1,
					level: 'error'
				});
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
					.catch((e) =>
						log(`etl: ${describe(claimed)} error: ${errorMessage(e)}`, {
							...jobFields(claimed),
							event: 'etl.job',
							outcome: 'error',
							level: 'error'
						})
					)
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
			`etl: stopping, waiting up to ${opts.shutdownTimeoutSeconds}s for ${active.size} running job(s)`,
			{ event: 'etl.stopping', workerId: opts.workerId, runningJobs: active.size }
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
					`etl: ${describe(job)} ${released ? 'released back to the queue' : 'could not be released'}`,
					{
						...jobFields(job),
						event: 'etl.job',
						outcome: released ? 'released' : 'release_failed',
						level: released ? 'info' : 'error'
					}
				);
			}
		}
	}

	return { done: all, stop };
}
