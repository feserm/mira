import { describe, expect, it } from 'vitest';
import { GET } from './+server';

describe('GET /healthz', () => {
	it('returns 200 without touching the database', async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});
});
