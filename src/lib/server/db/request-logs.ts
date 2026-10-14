import { db } from './index';
import { requestLogs } from './schema';

export interface RequestLog {
	endpoint: string;
	method: string;
	responseTimeMs: number;
	status: number;
}

const MAX_QUEUE_SIZE = 1000;
const BATCH_SIZE = 100;
const FLUSH_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

const queue: RequestLog[] = [];
let flushInProgress = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let consecutiveFailures = 0;

function scheduleFlush(delay: number): void {
	if (flushTimer) return;

	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		void flushRequestLogs();
	}, delay);

	if (typeof flushTimer === 'object' && 'unref' in flushTimer) flushTimer.unref();
}

async function flushRequestLogs(): Promise<void> {
	if (flushInProgress || queue.length === 0) return;

	flushInProgress = true;
	const batch = queue.splice(0, BATCH_SIZE);

	try {
		await db.insert(requestLogs).values(batch);
		consecutiveFailures = 0;
	} catch (error) {
		consecutiveFailures++;
		console.error(
			`Failed to flush ${batch.length} request log(s) (attempt ${consecutiveFailures}):`,
			error
		);
		queue.unshift(...batch);
		if (queue.length > MAX_QUEUE_SIZE) queue.splice(0, queue.length - MAX_QUEUE_SIZE);
	} finally {
		flushInProgress = false;
		if (queue.length > 0) {
			const delay =
				consecutiveFailures > 0
					? Math.min(FLUSH_DELAY_MS * 2 ** (consecutiveFailures - 1), MAX_RETRY_DELAY_MS)
					: queue.length >= BATCH_SIZE
						? 0
						: FLUSH_DELAY_MS;
			scheduleFlush(delay);
		}
	}
}

export function enqueueRequestLog(log: RequestLog): void {
	queue.push(log);
	if (queue.length > MAX_QUEUE_SIZE) queue.splice(0, queue.length - MAX_QUEUE_SIZE);

	if (queue.length >= BATCH_SIZE) {
		void flushRequestLogs();
	} else {
		scheduleFlush(FLUSH_DELAY_MS);
	}
}
