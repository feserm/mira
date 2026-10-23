import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { userDashboards } from '$lib/server/db/schema';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import { anonymousLocals, authenticatedLocals } from '$lib/server/test-support/brapi-event';
import { actions, load } from './+page.server';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);

/* eslint-disable @typescript-eslint/no-explicit-any */
const callLoad = async (locals: any) => {
	try {
		return {
			status: 200,
			data: (await (load as any)({ locals, url: new URL('http://x/') })) as any
		};
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, data: undefined };
		throw e;
	}
};

const saveLayout = async (locals: any) => {
	const body = new FormData();
	body.set('layout', '[]');
	return (actions as any).saveLayout({
		locals,
		request: new Request('http://x/', { method: 'POST', body })
	});
};

describe.skipIf(!hasTestDb)('dashboard access (S2.2)', () => {
	let t: DmlTestDb;

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(async () => {
		await t.db.delete(userDashboards);
	});

	it('shows an anonymous visitor the landing text and no data', async () => {
		const { status, data } = await callLoad(anonymousLocals());
		expect(status).toBe(200);
		expect(data).toEqual({ layout: expect.any(Array), authenticated: false });
	});

	it('answers 403 to a signed-in user who is not an admin', async () => {
		const { status, data } = await callLoad(authenticatedLocals(t.userId, 'user'));
		expect(status).toBe(403);
		expect(data).toBeUndefined();
	});

	it('gives an admin the analytics, the servers and a user list without avatars', async () => {
		const { status, data } = await callLoad(authenticatedLocals(t.userId, 'admin'));
		expect(status).toBe(200);
		expect(data.authenticated).toBe(true);
		expect(data.analytics).toBeDefined();
		expect(data.users.map((u: { id: string }) => u.id)).toContain(t.userId);
		for (const u of data.users) {
			expect(Object.keys(u).sort()).toEqual(['email', 'id', 'lastAccountUpdate', 'name', 'role']);
		}
	});

	it('lets only an admin save a layout', async () => {
		expect((await saveLayout(authenticatedLocals(t.userId, 'user'))).status).toBe(403);
		expect((await saveLayout(anonymousLocals())).status).toBe(401);
		expect(await t.db.select().from(userDashboards)).toHaveLength(0);
		expect(await saveLayout(authenticatedLocals(t.userId, 'admin'))).toEqual({ success: true });
		expect(await t.db.select().from(userDashboards)).toHaveLength(1);
	});
});

placeholderWithoutDb('dashboard access');
