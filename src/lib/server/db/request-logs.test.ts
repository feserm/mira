import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const values = vi.fn();
vi.mock('./index', () => ({ db: { insert: () => ({ values }) } }));

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
	values.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const log = (n: number) => ({
	endpoint: `/r/brapi/v2/${n}`,
	method: 'GET',
	responseTimeMs: 1,
	status: 200
});

describe('flushAndStop', () => {
	it('writes queued logs immediately and cancels the pending timer', async () => {
		values.mockResolvedValue(undefined);
		const { enqueueRequestLog, flushAndStop } = await import('./request-logs');
		enqueueRequestLog(log(1));
		enqueueRequestLog(log(2));
		expect(values).not.toHaveBeenCalled();

		await flushAndStop();
		expect(values).toHaveBeenCalledTimes(1);
		expect(values.mock.calls[0][0]).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(5000);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('drains more than one batch', async () => {
		values.mockResolvedValue(undefined);
		const { enqueueRequestLog, flushAndStop } = await import('./request-logs');
		for (let i = 0; i < 250; i++) enqueueRequestLog(log(i));
		await flushAndStop();
		const total = values.mock.calls.reduce((n, [batch]) => n + batch.length, 0);
		expect(total).toBe(250);
	});

	it('is bounded by the timeout when the database hangs', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		values.mockReturnValue(new Promise(() => {}));
		const { enqueueRequestLog, flushAndStop } = await import('./request-logs');
		enqueueRequestLog(log(1));
		const done = flushAndStop(1000);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(done).resolves.toBeUndefined();
	});

	it('gives up after a failed insert instead of retrying forever', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		values.mockRejectedValue(new Error('down'));
		const { enqueueRequestLog, flushAndStop } = await import('./request-logs');
		enqueueRequestLog(log(1));
		await flushAndStop();
		expect(values).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not schedule new flushes after stopping', async () => {
		values.mockResolvedValue(undefined);
		const { enqueueRequestLog, flushAndStop } = await import('./request-logs');
		await flushAndStop();
		enqueueRequestLog(log(1));
		expect(vi.getTimerCount()).toBe(0);
	});
});
