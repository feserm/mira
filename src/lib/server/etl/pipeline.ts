import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import { extractRoCrate } from './extract';
import { transformRoCrate } from './transform';
import { loadEntities } from './load';
import { errorMessage, isTransient } from './errors';
import { markStagingStepFailed, type JobStep } from './queue';

/** What a step needs from its caller: who runs it, and how to get a PLANTdataHUB token. The token
 *  is fetched lazily and only by Extract, so Transform and Load jobs never need one. */
export interface StepContext {
	userId: string;
	getToken: () => Promise<string>;
}

export type StepResult = { ok: true } | { ok: false; error: string; transient: boolean };

const OK: StepResult = { ok: true };

/** Records the failure in `ro_crate_staging` (a no-op while no row exists yet) and reports it. */
async function failed(e: unknown, step: JobStep, arcId: number): Promise<StepResult> {
	const message = errorMessage(e);
	await markStagingStepFailed(db, arcId, step, message);
	return { ok: false, error: message, transient: isTransient(e) };
}

export async function resetDownstream(
	arcId: number,
	steps: Array<'transform' | 'load'>
): Promise<void> {
	const set: Record<string, unknown> = {};
	if (steps.includes('transform')) {
		set.transformStatus = 'pending';
		set.transformedAt = null;
		set.transformedBy = null;
		set.transformError = null;
	}
	if (steps.includes('load')) {
		set.loadStatus = 'pending';
		set.loadedAt = null;
		set.loadedBy = null;
		set.loadError = null;
	}
	await db.update(roCrateStaging).set(set).where(eq(roCrateStaging.arcId, arcId));
}

export async function runExtractStep(ctx: StepContext, arcId: number): Promise<StepResult> {
	try {
		await extractRoCrate(await ctx.getToken(), ctx.userId, arcId);
		return OK;
	} catch (e) {
		return failed(e, 'extract', arcId);
	}
}

export async function runTransformStep(
	ctx: StepContext,
	arcId: number,
	rawRoCrate: unknown
): Promise<StepResult> {
	try {
		await transformRoCrate(rawRoCrate, arcId);
		await db
			.update(roCrateStaging)
			.set({
				transformStatus: 'success',
				transformedAt: new Date(),
				transformedBy: ctx.userId,
				transformError: null
			})
			.where(eq(roCrateStaging.arcId, arcId));
		return OK;
	} catch (e) {
		return failed(e, 'transform', arcId);
	}
}

export async function runLoadStep(
	ctx: StepContext,
	arcId: number,
	rawRoCrate: unknown
): Promise<StepResult> {
	try {
		const result = await transformRoCrate(rawRoCrate, arcId);
		await loadEntities(result, arcId);
		await db
			.update(roCrateStaging)
			.set({
				loadStatus: 'success',
				loadedAt: new Date(),
				loadedBy: ctx.userId,
				loadError: null
			})
			.where(eq(roCrateStaging.arcId, arcId));
		return OK;
	} catch (e) {
		return failed(e, 'load', arcId);
	}
}
