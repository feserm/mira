import { isHttpError, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { roCrateStaging } from '$lib/server/db/schema';
import { extractRoCrate } from './extract';
import { transformRoCrate } from './transform';
import { loadEntities } from './load';

function errorMessage(e: unknown): string {
	if (isHttpError(e)) return e.body.message;
	return e instanceof Error ? e.message : String(e);
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

export async function runExtractStep(event: RequestEvent, arcId: number): Promise<boolean> {
	try {
		await extractRoCrate(event, arcId);
		return true;
	} catch (e) {
		await db
			.update(roCrateStaging)
			.set({ extractStatus: 'failed', extractError: errorMessage(e) })
			.where(eq(roCrateStaging.arcId, arcId));
		return false;
	}
}

export async function runTransformStep(
	event: RequestEvent,
	arcId: number,
	rawRoCrate: unknown
): Promise<boolean> {
	try {
		await transformRoCrate(rawRoCrate, arcId);
		await db
			.update(roCrateStaging)
			.set({
				transformStatus: 'success',
				transformedAt: new Date(),
				transformedBy: event.locals.user!.id,
				transformError: null
			})
			.where(eq(roCrateStaging.arcId, arcId));
		return true;
	} catch (e) {
		await db
			.update(roCrateStaging)
			.set({ transformStatus: 'failed', transformError: errorMessage(e) })
			.where(eq(roCrateStaging.arcId, arcId));
		return false;
	}
}

export async function runLoadStep(
	event: RequestEvent,
	arcId: number,
	rawRoCrate: unknown
): Promise<boolean> {
	try {
		const result = await transformRoCrate(rawRoCrate, arcId);
		await loadEntities(result);
		await db
			.update(roCrateStaging)
			.set({
				loadStatus: 'success',
				loadedAt: new Date(),
				loadedBy: event.locals.user!.id,
				loadError: null
			})
			.where(eq(roCrateStaging.arcId, arcId));
		return true;
	} catch (e) {
		await db
			.update(roCrateStaging)
			.set({ loadStatus: 'failed', loadError: errorMessage(e) })
			.where(eq(roCrateStaging.arcId, arcId));
		return false;
	}
}
