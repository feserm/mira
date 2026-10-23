import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const callLoad = async (locals: any) => ({
	status: 200,
	data: (await (load as any)({ locals, url: new URL('http://x/') })) as any
});

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

	it('gives a signed-in non-admin the dashboard without the user list or the user widget', async () => {
		const { status, data } = await callLoad(authenticatedLocals(t.userId, 'user'));
		expect(status).toBe(200);
		expect(data.authenticated).toBe(true);
		expect(data.admin).toBe(false);
		expect(data.analytics).toBeDefined();
		expect(data.users).toEqual([]);
		expect(data.layout.map((i: { type: string }) => i.type)).not.toContain('UserStats');
		expect(data.layout.length).toBeGreaterThan(0);
	});

	it('gives an admin the user list (name, e-mail, role, last activity; no avatar) and the user widget', async () => {
		const { status, data } = await callLoad(authenticatedLocals(t.userId, 'admin'));
		expect(status).toBe(200);
		expect(data.admin).toBe(true);
		expect(data.analytics).toBeDefined();
		expect(data.layout.map((i: { type: string }) => i.type)).toContain('UserStats');
		expect(data.users.map((u: { id: string }) => u.id)).toContain(t.userId);
		for (const u of data.users) {
			expect(Object.keys(u).sort()).toEqual(['email', 'id', 'lastAccountUpdate', 'name', 'role']);
		}
	});

	it('lets any signed-in user save a layout, but never stores the user widget for a non-admin', async () => {
		const save = (locals: any, layout: unknown) => {
			const body = new FormData();
			body.set('layout', JSON.stringify(layout));
			return (actions as any).saveLayout({
				locals,
				request: new Request('http://x/', { method: 'POST', body })
			});
		};
		const items = [
			{ id: 'a', x: 0, y: 0, w: 1, h: 1, type: 'ServerStats' },
			{ id: 'b', x: 1, y: 0, w: 1, h: 1, type: 'UserStats' }
		];
		expect((await saveLayout(anonymousLocals())).status).toBe(401);
		expect(await save(authenticatedLocals(t.userId, 'user'), items)).toEqual({ success: true });
		const [row] = await t.db.select().from(userDashboards);
		expect(row.layout.map((i) => i.type)).toEqual(['ServerStats']);
		expect(await save(authenticatedLocals(t.userId, 'admin'), items)).toEqual({ success: true });
		const [row2] = await t.db.select().from(userDashboards);
		expect(row2.layout.map((i) => i.type)).toEqual(['ServerStats', 'UserStats']);
	});
});

placeholderWithoutDb('dashboard access');
