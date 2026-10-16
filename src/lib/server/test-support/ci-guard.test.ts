import { describe, expect, it } from 'vitest';
import { hasTestDb } from '$lib/server/etl/test-db';

// The integration suites are skipped when TEST_DATABASE_URL is unset (so `pnpm test` works on a laptop
// without Postgres). In CI that would silently turn the safety net off, so there it is an error.
describe('integration tests are not skipped in CI', () => {
	it('has TEST_DATABASE_URL when CI is set', () => {
		if (process.env.CI) {
			expect(
				hasTestDb,
				'CI is set but TEST_DATABASE_URL is not: the Postgres suites would be skipped'
			).toBe(true);
		} else {
			expect(typeof hasTestDb).toBe('boolean');
		}
	});
});
