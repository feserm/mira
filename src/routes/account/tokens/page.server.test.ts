import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isHttpError, type ActionFailure } from '@sveltejs/kit';
import { createApiToken, verifyApiToken } from '$lib/server/api-token';
import {
	anonymousLocals,
	authenticatedLocals,
	type Locals
} from '$lib/server/test-support/brapi-event';
import { useTestDb } from '$lib/server/test-support/db-mock';
import { createDmlTestDb, hasTestDb, type DmlTestDb } from '$lib/server/test-support/dml-db';
import { actions, load } from './+page.server';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function event(locals: Locals, fields: Record<string, string> = {}, headers: HeadersInit = {}) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const response: Record<string, string> = {};
	return {
		ev: {
			locals,
			request: new Request('http://localhost/account/tokens', { method: 'POST', body, headers }),
			setHeaders: (h: Record<string, string>) => Object.assign(response, h)
		} as Any,
		response
	};
}

async function run(fn: () => unknown) {
	try {
		return { value: (await fn()) as Any };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, value: undefined as Any };
		if ((e as { status?: number }).status && (e as { location?: string }).location)
			return {
				status: (e as { status: number }).status,
				location: (e as Any).location,
				value: undefined as Any
			};
		throw e;
	}
}

describe.skipIf(!hasTestDb)('/account/tokens (real Postgres, DML-only role)', () => {
	let t: DmlTestDb;
	let other: string;
	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
		other = `u-other-${Math.random().toString(36).slice(2)}`;
		await t.client`insert into "user" (id, name, email) values (${other}, 'O', ${other + '@example.org'})`;
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});

	const me = () => authenticatedLocals(t.userId);

	it('creates a token, returns the secret in that response only, and marks it uncacheable', async () => {
		const { ev, response } = event(me(), { name: ' notebook ', expiresInDays: '90' });
		const res = (await actions.create(ev)) as Any;
		expect(res.created.token).toMatch(/^mira_/);
		expect(res.created.name).toBe('notebook');
		expect(response['cache-control']).toBe('no-store');
		expect((await verifyApiToken(res.created.token))?.user.id).toBe(t.userId);

		const page = (await load({
			...event(me()).ev,
			request: new Request('http://localhost/')
		})) as Any;
		expect(JSON.stringify(page)).not.toContain(res.created.token);
		expect(page.tokens.map((x: Any) => x.name)).toContain('notebook');
	});

	it('supports every lifetime, including "never" only when asked for explicitly', async () => {
		for (const [value, days] of [
			['30', 30],
			['365', 365],
			['never', null]
		] as const) {
			const res = (await actions.create(
				event(me(), { name: value, expiresInDays: value }).ev
			)) as Any;
			if (days === null) expect(res.created.expiresAt).toBeNull();
			else expect(res.created.expiresAt).toBeInstanceOf(Date);
		}
		const bad = (await actions.create(
			event(me(), { name: 'x', expiresInDays: '' }).ev
		)) as ActionFailure;
		expect(bad.status).toBe(400);
		const odd = (await actions.create(
			event(me(), { name: 'x', expiresInDays: '7' }).ev
		)) as ActionFailure;
		expect(odd.status).toBe(400);
	});

	it('rejects an empty or overlong name', async () => {
		for (const name of ['', '   ', 'x'.repeat(81)]) {
			const res = (await actions.create(
				event(me(), { name, expiresInDays: '30' }).ev
			)) as ActionFailure;
			expect(res.status).toBe(400);
		}
	});

	it('lists only your own tokens', async () => {
		await createApiToken(other, 'secret-of-other', 30);
		const page = (await load(event(me()).ev)) as Any;
		expect(JSON.stringify(page.tokens)).not.toContain('secret-of-other');
		const theirs = (await load(event(authenticatedLocals(other)).ev)) as Any;
		expect(theirs.tokens.map((x: Any) => x.name)).toEqual(['secret-of-other']);
	});

	it('revokes your own token, and answers 404 for someone else’s or an unknown one', async () => {
		const mine = await createApiToken(t.userId, 'mine', 30);
		const theirs = await createApiToken(other, 'theirs', 30);

		expect((await run(() => actions.revoke(event(me(), { id: theirs.info.id }).ev))).status).toBe(
			404
		);
		expect(await verifyApiToken(theirs.token)).toBeDefined();
		expect((await run(() => actions.revoke(event(me(), { id: 'nope' }).ev))).status).toBe(404);
		expect(
			(await run(() => actions.revoke(event(me(), { id: crypto.randomUUID() }).ev))).status
		).toBe(404);

		await actions.revoke(event(me(), { id: mine.info.id }).ev);
		expect(await verifyApiToken(mine.token)).toBeUndefined();
	});

	it('does not let an admin revoke someone else’s token either', async () => {
		const theirs = await createApiToken(other, 'theirs-2', 30);
		const admin = authenticatedLocals(t.userId, 'admin');
		expect((await run(() => actions.revoke(event(admin, { id: theirs.info.id }).ev))).status).toBe(
			404
		);
		expect(await verifyApiToken(theirs.token)).toBeDefined();
	});

	it('caps the number of active tokens per user', async () => {
		const capUser = `u-cap-${Math.random().toString(36).slice(2)}`;
		await t.client`insert into "user" (id, name, email) values (${capUser}, 'C', ${capUser + '@example.org'})`;
		const locals = authenticatedLocals(capUser);
		for (let i = 0; i < 25; i++) await createApiToken(capUser, `t${i}`, 30);
		const res = (await actions.create(
			event(locals, { name: 'one more', expiresInDays: '30' }).ev
		)) as ActionFailure;
		expect(res.status).toBe(400);
	});

	describe('session only', () => {
		it('anonymous callers get 401 on every action and a redirect from the page', async () => {
			expect(
				(
					await run(() =>
						actions.create(event(anonymousLocals(), { name: 'x', expiresInDays: '30' }).ev)
					)
				).status
			).toBe(401);
			expect(
				(await run(() => actions.revoke(event(anonymousLocals(), { id: crypto.randomUUID() }).ev)))
					.status
			).toBe(401);
			expect((await run(() => load(event(anonymousLocals()).ev))).status).toBe(303);
		});

		it('an Authorization header is refused even next to a valid session', async () => {
			const { token } = await createApiToken(t.userId, 'manager', 30);
			const headers = { authorization: `Bearer ${token}` };
			const created = await run(() =>
				actions.create(event(me(), { name: 'child', expiresInDays: '30' }, headers).ev)
			);
			expect(created.status).toBe(401);
			const mine = await createApiToken(t.userId, 'target', 30);
			expect(
				(await run(() => actions.revoke(event(me(), { id: mine.info.id }, headers).ev))).status
			).toBe(401);
			expect(await verifyApiToken(mine.token)).toBeDefined();
			expect((await run(() => load(event(me(), {}, headers).ev))).status).toBe(401);
		});
	});
});
