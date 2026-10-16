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
let inflight: Promise<void> | undefined;
let stopped = false;

function scheduleFlush(delay: number): void {
	if (stopped || flushTimer) return;

	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		void flushRequestLogs();
	}, delay);

	if (typeof flushTimer === 'object' && 'unref' in flushTimer) flushTimer.unref();
}

function flushRequestLogs(): Promise<void> {
	if (flushInProgress || queue.length === 0) return Promise.resolve();
	inflight = flushBatch();
	return inflight;
}

async function flushBatch(): Promise<void> {
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

/** Drains the queue for shutdown, bounded by `timeoutMs`, and stops further timer-driven flushes.
 *  Gives up early after a failed insert (the logs are best-effort; don't hold up the exit). */
export async function flushAndStop(timeoutMs = 3000): Promise<void> {
	stopped = true;
	clearTimeout(flushTimer);
	flushTimer = undefined;

	const drain = async () => {
		while (queue.length > 0 || flushInProgress) {
			if (flushInProgress) await inflight;
			else await flushRequestLogs();
			if (consecutiveFailures > 0) return;
		}
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			drain(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}

	if (queue.length > 0)
		console.error(`Dropping ${queue.length} unflushed request log(s) on shutdown`);
}
