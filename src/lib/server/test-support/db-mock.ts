/** Stands in for `$lib/server/db` (which connects at import time from validated env) in tests.
 *  In a test file:
 *
 *    vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
 *    ...
 *    beforeAll(async () => { t = await createDmlTestDb(); useTestDb(t.db); });
 *
 *  Production code keeps importing `db` as before; no production function takes a db parameter for tests. */
import type { AppDb } from './dml-db';

let current: AppDb | undefined;

export function useTestDb(db: AppDb | undefined) {
	current = db;
}

const dbProxy = new Proxy({} as AppDb, {
	get(_target, prop) {
		if (!current) throw new Error('db-mock: useTestDb() was not called');
		const value = Reflect.get(current, prop);
		return typeof value === 'function' ? value.bind(current) : value;
	}
});

export const dbModule = { db: dbProxy, closeDb: async () => {} };
