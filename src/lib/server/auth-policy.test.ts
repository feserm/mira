import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { betterAuth } from 'better-auth/minimal';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import { account, session, user } from '$lib/server/db/schema';
import { baseAuthOptions, oidcPlugin } from '$lib/server/auth-options';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock('$lib/server/env', () => ({
	config: {
		origin: 'https://mira.test',
		authSecret: 'x'.repeat(40),
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

placeholderWithoutDb('sign-in policy');
