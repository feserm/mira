import type { EtlJob } from '$lib/server/db/schema';
import type { JobView } from '$lib/types/etl';

export function toJobView(job: EtlJob | null): JobView | null {
	if (!job) return null;
	return {
		id: job.id,
		kind: job.kind,
		state: job.state,
		currentStep: job.currentStep,
		attempts: job.attempts,
		maxAttempts: job.maxAttempts,
		error: job.error,
		createdAt: job.createdAt.toISOString(),
		finishedAt: job.finishedAt?.toISOString() ?? null
	};
}
