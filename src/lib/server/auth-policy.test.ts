import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { betterAuth } from 'better-auth/minimal';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import { eq } from 'drizzle-orm';
import { account, session, user } from '$lib/server/db/schema';
import { makeSignature } from 'better-auth/crypto';
import {
	baseAuthOptions,
	oidcPlugin,
	roleForEmail,
	sharedPlugins,
	syncRole
} from '$lib/server/auth-options';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock('$lib/server/env', () => ({
	config: {
		origin: 'https://mira.test',
		authSecret: 'x'.repeat(40),
		adminEmails: ['admin@example.org'],
		oidc: {
			issuerUrl: 'https://gitlab.test',
			clientId: 'client',
			clientSecret: 'secret',
			scopes: ['openid', 'profile', 'email', 'read_api']
		}
	}
}));

const post = (path: string, body: unknown) =>
	new Request(`https://mira.test/api/auth${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: 'https://mira.test' },
		body: JSON.stringify(body)
	});

describe.skipIf(!hasTestDb)('sign-in policy: OIDC only (S2.1)', () => {
	let t: DmlTestDb;
	const auth = () =>
		betterAuth({
			...baseAuthOptions,
			secret: 'x'.repeat(40),
			plugins: [oidcPlugin()]
		});

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});

	it('refuses email sign-up and creates no user, account or session', async () => {
		const before = (await t.db.select().from(user)).length;
		const res = await auth().handler(
			post('/sign-up/email', { email: 'new@example.org', password: 'password-1234', name: 'New' })
		);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
		expect(await t.db.select().from(user)).toHaveLength(before);
		expect(await t.db.select().from(account)).toHaveLength(0);
		expect(await t.db.select().from(session)).toHaveLength(0);
	});

	it('refuses email sign-in', async () => {
		const res = await auth().handler(
			post('/sign-in/email', { email: 'x@example.org', password: 'password-1234' })
		);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
	});
});

describe('roleForEmail', () => {
	it('is admin only for a listed address, ignoring case and spaces', () => {
		expect(roleForEmail(' Admin@Example.org ', ['admin@example.org'])).toBe('admin');
		expect(roleForEmail('other@example.org', ['admin@example.org'])).toBe('user');
		expect(roleForEmail('admin@example.org', [])).toBe('user');
	});
});

describe.skipIf(!hasTestDb)('admin bootstrap at sign-in (S2.2)', () => {
	let t: DmlTestDb;
	const roleOf = async (id: string) =>
		(await t.db.select({ role: user.role }).from(user).where(eq(user.id, id)))[0]?.role;
	const add = (id: string, email: string, role: string | null) =>
		t.db.insert(user).values({ id, name: id, email, role });

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});

	it('promotes a listed user, leaves others plain, demotes an admin who was removed from the list', async () => {
		await add('a', 'Admin@example.org', null);
		await add('b', 'b@example.org', null);
		await add('c', 'c@example.org', 'admin');
		for (const id of ['a', 'b', 'c']) await syncRole(id);
		expect(await roleOf('a')).toBe('admin');
		expect(await roleOf('b')).toBe('user');
		expect(await roleOf('c')).toBe('user');
	});

	it('makes a listed user admin when a session is created, and getSession reports the role', async () => {
		const secret = 'x'.repeat(40);
		const instance = betterAuth({ ...baseAuthOptions, secret, plugins: sharedPlugins() });
		const ctx = await instance.$context;
		for (const [id, email, expected] of [
			['d', 'admin@example.org', 'admin'],
			['e', 'e@example.org', 'user']
		] as const) {
			await add(id, email, null);
			const { token } = await ctx.internalAdapter.createSession(id);
			const headers = new Headers({
				cookie: `${ctx.authCookies.sessionToken.name}=${token}.${await makeSignature(token, secret)}`
			});
			const result = await instance.api.getSession({ headers });
			expect((result?.user as { role?: string }).role).toBe(expected);
		}
	});

	it('ignores an unknown user id', async () => {
		await syncRole('missing');
		expect(await roleOf('missing')).toBeUndefined();
	});
});

placeholderWithoutDb('sign-in policy');
