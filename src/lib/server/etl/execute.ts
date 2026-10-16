import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import {
	resetDownstream,
	runExtractStep,
	runLoadStep,
	runTransformStep,
	type StepContext,
	type StepResult
} from './pipeline';
import type { JobKind, JobStep } from './queue';

export interface ExecuteContext extends StepContext {
	/** Called before each step. Returns false when the job's claim was lost: stop at once. */
	beginStep: (step: JobStep) => Promise<boolean>;
}

export type ExecuteResult = StepResult | { ok: false; lost: true };

const LOST: ExecuteResult = { ok: false, lost: true };

async function readStaging(arcId: number) {
	const [row] = await db
		.select({
			rawRoCrate: roCrateStaging.rawRoCrate,
			extractStatus: roCrateStaging.extractStatus,
			transformStatus: roCrateStaging.transformStatus
		})
		.from(roCrateStaging)
		.where(eq(roCrateStaging.arcId, arcId));
	return row;
}

const precondition = (error: string): ExecuteResult => ({ ok: false, error, transient: false });

/** Runs one job's steps in order, with exactly the semantics the form actions used to have:
 *  - full:      reset Transform/Load, Extract, then Transform, then Load
 *  - transform: reset Load, Transform, then Load (needs a successful Extract)
 *  - load:      Load (needs a successful Transform)
 *  A failed step stops the job; the step already recorded its failure in `ro_crate_staging`. */
export async function executeJob(
	kind: JobKind,
	arcId: number,
	ctx: ExecuteContext
): Promise<ExecuteResult> {
	let raw: unknown;

	if (kind === 'full') {
		await resetDownstream(arcId, ['transform', 'load']);
		if (!(await ctx.beginStep('extract'))) return LOST;
		const extracted = await runExtractStep(ctx, arcId);
		if (!extracted.ok) return extracted;
		raw = (await readStaging(arcId))?.rawRoCrate;
	} else {
		const row = await readStaging(arcId);
		if (kind === 'transform') {
			if (row?.extractStatus !== 'success')
				return precondition('Extract must succeed before transforming.');
			await resetDownstream(arcId, ['load']);
		} else if (row?.transformStatus !== 'success') {
			return precondition('Transform must succeed before loading.');
		}
		raw = row.rawRoCrate;
	}

	if (kind !== 'load') {
		if (!(await ctx.beginStep('transform'))) return LOST;
		const transformed = await runTransformStep(ctx, arcId, raw);
		if (!transformed.ok) return transformed;
	}

	if (!(await ctx.beginStep('load'))) return LOST;
	return runLoadStep(ctx, arcId, raw);
}
