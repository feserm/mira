import type { EtlJob } from '$lib/server/db/schema'; // type only: erased at build

/** What the browser may see of a job: no user ids, no worker names. */
export interface JobView {
	id: string;
	kind: EtlJob['kind'];
	state: EtlJob['state'];
	currentStep: EtlJob['currentStep'];
	attempts: number;
	maxAttempts: number;
	error: string | null;
	createdAt: string;
	finishedAt: string | null;
}
