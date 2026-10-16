/** The ETL job queue: plain functions over the `etl_job` table, no dependency beyond drizzle. The
 *  database is a parameter, so the web app, the worker and the tests (which use a throwaway database)
 *  share this code. All time arithmetic uses the database clock (`now()`), never the pod's, so clock
 *  skew between pods cannot expire a healthy lease. Design and failure modes: docs/etl-worker.md. */
import { and, desc, eq, lt, lte, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { etlJob, roCrateStaging, type EtlJob } from '$lib/server/db/schema';

// Only the tables the queue touches, so tests can pass a plain drizzle instance.
type Db = PostgresJsDatabase<Record<string, unknown>>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type JobKind = EtlJob['kind'];
export type JobStep = NonNullable<EtlJob['currentStep']>;

/** Identifies one claim of one job. Every write by a running worker is fenced on it: if the job
 *  was reclaimed meanwhile, `attempts` has moved on and the old worker's writes match nothing. */
export type JobClaim = Pick<EtlJob, 'id' | 'arcId' | 'attempts'> & { workerId: string };

const ACTIVE = ['queued', 'running'] as const;

export interface EnqueueInput {
	arcId: number;
	kind: JobKind;
	requestedBy: string;
	maxAttempts?: number;
}

/** Inserts a job, or returns the ARC's already active (queued or running) job. The partial unique
 *  index `etl_job_one_active_per_arc` makes this race-free: two concurrent callers get the same job. */
export async function enqueue(
	db: Db,
	input: EnqueueInput
): Promise<{ job: EtlJob; created: boolean }> {
	const [inserted] = await db
		.insert(etlJob)
		.values({
			arcId: input.arcId,
			kind: input.kind,
			requestedBy: input.requestedBy,
			...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {})
		})
		.onConflictDoNothing()
		.returning();
	if (inserted) return { job: inserted, created: true };

	const [existing] = await db
		.select()
		.from(etlJob)
		.where(and(eq(etlJob.arcId, input.arcId), or(...ACTIVE.map((s) => eq(etlJob.state, s)))));
	// The active job finished between the insert and this select: try once more.
	if (!existing) return enqueue(db, input);
	return { job: existing, created: false };
}

export async function getLatestJob(db: Db, arcId: number): Promise<EtlJob | null> {
	const [job] = await db
		.select()
		.from(etlJob)
		.where(eq(etlJob.arcId, arcId))
		.orderBy(desc(etlJob.createdAt), desc(etlJob.id))
		.limit(1);
	return job ?? null;
}

const leaseFrom = (seconds: number) => sql`now() + make_interval(secs => ${seconds})`;

/** Claims the oldest due job: `queued`, or `running` with an expired lease (its worker died).
 *  `FOR UPDATE SKIP LOCKED` means concurrent claimers never block each other or get the same row. */
export async function claim(
	db: Db,
	workerId: string,
	leaseSeconds: number
): Promise<EtlJob | undefined> {
	return db.transaction(async (tx) => {
		const [next] = await tx
			.select({ id: etlJob.id })
			.from(etlJob)
			.where(
				or(
					and(eq(etlJob.state, 'queued'), lte(etlJob.runAfter, sql`now()`)),
					and(
						eq(etlJob.state, 'running'),
						lt(etlJob.leaseExpiresAt, sql`now()`),
						// An exhausted job is failed by reapExpired, not run again.
						lt(etlJob.attempts, etlJob.maxAttempts)
					)
				)
			)
			.orderBy(etlJob.createdAt)
			.limit(1)
			.for('update', { skipLocked: true });
		if (!next) return undefined;

		const [job] = await tx
			.update(etlJob)
			.set({
				state: 'running',
				attempts: sql`${etlJob.attempts} + 1`,
				lockedBy: workerId,
				leaseExpiresAt: leaseFrom(leaseSeconds),
				startedAt: sql`coalesce(${etlJob.startedAt}, now())`,
				currentStep: null,
				updatedAt: sql`now()`
			})
			.where(eq(etlJob.id, next.id))
			.returning();
		return job;
	});
}

const fenced = (c: JobClaim) =>
	and(
		eq(etlJob.id, c.id),
		eq(etlJob.state, 'running'),
		eq(etlJob.lockedBy, c.workerId),
		eq(etlJob.attempts, c.attempts)
	);

/** Extends the lease. `false` means the claim was lost (reclaimed by another worker, or the job was
 *  finished): the caller must stop working on it. */
export async function heartbeat(db: Db, c: JobClaim, leaseSeconds: number): Promise<boolean> {
	const rows = await db
		.update(etlJob)
		.set({ leaseExpiresAt: leaseFrom(leaseSeconds), updatedAt: sql`now()` })
		.where(fenced(c))
		.returning({ id: etlJob.id });
	return rows.length > 0;
}

export async function setStep(db: Db, c: JobClaim, step: JobStep): Promise<boolean> {
	const rows = await db
		.update(etlJob)
		.set({ currentStep: step, updatedAt: sql`now()` })
		.where(fenced(c))
		.returning({ id: etlJob.id });
	return rows.length > 0;
}

export async function complete(db: Db, c: JobClaim): Promise<boolean> {
	const rows = await db
		.update(etlJob)
		.set({
			state: 'succeeded',
			error: null,
			currentStep: null,
			lockedBy: null,
			leaseExpiresAt: null,
			finishedAt: sql`now()`,
			updatedAt: sql`now()`
		})
		.where(fenced(c))
		.returning({ id: etlJob.id });
	return rows.length > 0;
}

export type FailOutcome = 'retry' | 'failed' | 'lost';

/** Records a failure. A transient failure with attempts left puts the job back in the queue after
 *  `retryDelaySeconds x attempts`; anything else is final. */
export async function fail(
	db: Db,
	c: JobClaim,
	error: string,
	opts: { transient: boolean; retryDelaySeconds: number }
): Promise<FailOutcome> {
	const [row] = await db
		.select({ attempts: etlJob.attempts, maxAttempts: etlJob.maxAttempts })
		.from(etlJob)
		.where(fenced(c));
	if (!row) return 'lost';

	if (opts.transient && row.attempts < row.maxAttempts) {
		const rows = await db
			.update(etlJob)
			.set({
				state: 'queued',
				error,
				lockedBy: null,
				leaseExpiresAt: null,
				runAfter: sql`now() + make_interval(secs => ${opts.retryDelaySeconds * row.attempts})`,
				updatedAt: sql`now()`
			})
			.where(fenced(c))
			.returning({ id: etlJob.id });
		return rows.length ? 'retry' : 'lost';
	}

	const rows = await db
		.update(etlJob)
		.set({
			state: 'failed',
			error,
			lockedBy: null,
			leaseExpiresAt: null,
			finishedAt: sql`now()`,
			updatedAt: sql`now()`
		})
		.where(fenced(c))
		.returning({ id: etlJob.id });
	return rows.length ? 'failed' : 'lost';
}

/** Gives a job back (graceful shutdown). The attempt is not counted and no delay applies. */
export async function release(db: Db, c: JobClaim, note: string): Promise<boolean> {
	const rows = await db
		.update(etlJob)
		.set({
			state: 'queued',
			attempts: sql`${etlJob.attempts} - 1`,
			error: note,
			lockedBy: null,
			leaseExpiresAt: null,
			runAfter: sql`now()`,
			updatedAt: sql`now()`
		})
		.where(fenced(c))
		.returning({ id: etlJob.id });
	return rows.length > 0;
}

const STEP_COLUMNS = {
	extract: { status: 'extractStatus', error: 'extractError' },
	transform: { status: 'transformStatus', error: 'transformError' },
	load: { status: 'loadStatus', error: 'loadError' }
} as const;

/** Marks a step failed in `ro_crate_staging`. A no-op when the row does not exist yet (the first
 *  Extract never completed; the job row carries the error then). */
export async function markStagingStepFailed(
	db: Db | Tx,
	arcId: number,
	step: JobStep,
	message: string
): Promise<void> {
	const cols = STEP_COLUMNS[step];
	await db
		.update(roCrateStaging)
		.set({ [cols.status]: 'failed', [cols.error]: message })
		.where(eq(roCrateStaging.arcId, arcId));
}

/** Fails running jobs whose lease expired and whose attempts are used up (the worker died on its last
 *  attempt), and makes `ro_crate_staging` say so. Jobs with attempts left are reclaimed by `claim`. */
export async function reapExpired(db: Db): Promise<EtlJob[]> {
	return db.transaction(async (tx) => {
		const message = 'The worker running this import stopped responding. Please retry.';
		const reaped = await tx
			.update(etlJob)
			.set({
				state: 'failed',
				error: message,
				lockedBy: null,
				leaseExpiresAt: null,
				finishedAt: sql`now()`,
				updatedAt: sql`now()`
			})
			.where(
				and(
					eq(etlJob.state, 'running'),
					lt(etlJob.leaseExpiresAt, sql`now()`),
					sql`${etlJob.attempts} >= ${etlJob.maxAttempts}`
				)
			)
			.returning();
		for (const job of reaped) {
			if (job.currentStep) await markStagingStepFailed(tx, job.arcId, job.currentStep, message);
		}
		return reaped;
	});
}

/** Namespace for the per-ARC advisory lock, so it cannot collide with other users of advisory locks. */
const ARC_LOCK_NAMESPACE = 0x4d49; // "MI"

/** Serializes writers of one ARC's data. Transaction-scoped on purpose: released at commit/rollback,
 *  so it is safe with PgBouncer transaction pooling (a session-level lock is not). Call it as the
 *  first statement of the transaction. */
export async function lockArc(tx: Tx, arcId: number): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(${ARC_LOCK_NAMESPACE}, ${arcId})`);
}
