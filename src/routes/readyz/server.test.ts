import { afterEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
vi.mock('$lib/server/db', () => ({ db: { execute } }));

const { GET } = await import('./+server');
const call = () => GET({} as Parameters<typeof GET>[0]);

describe('GET /readyz', () => {
	afterEach(() => {
		vi.useRealTimers();
		execute.mockReset();
		vi.restoreAllMocks();
	});

	it('returns 200 when the database answers', async () => {
		execute.mockResolvedValue([{ '?column?': 1 }]);
		const response = await call();
		expect(response.status).toBe(200);
	});

	it('returns 503 when the query fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		execute.mockRejectedValue(new Error('connection refused'));
		const response = await call();
		expect(response.status).toBe(503);
	});

	it('returns 503 when the query hangs past the timeout', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		execute.mockReturnValue(new Promise(() => {}));
		const pending = call();
		await vi.advanceTimersByTimeAsync(2100);
		const response = await pending;
		expect(response.status).toBe(503);
	});
});
