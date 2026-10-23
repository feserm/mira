import { describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { isAdmin, requireAdmin } from './auth-guard';

const as = (role: string | null | undefined) => ({
	locals: { user: { id: 'u', name: 'U', email: 'u@example.org', role } as never }
});

function statusOf(fn: () => unknown): number | undefined {
	try {
		fn();
	} catch (e) {
		return isHttpError(e) ? e.status : undefined;
	}
}

describe('requireAdmin', () => {
	it('answers 401 for nobody, 403 for a user or a user without a role, and lets an admin through', () => {
		expect(statusOf(() => requireAdmin({ locals: {} }))).toBe(401);
		expect(statusOf(() => requireAdmin(as('user')))).toBe(403);
		expect(statusOf(() => requireAdmin(as(null)))).toBe(403);
		expect(statusOf(() => requireAdmin(as(undefined)))).toBe(403);
		expect(requireAdmin(as('admin')).id).toBe('u');
	});

	it('does not treat a look-alike role as admin', () => {
		expect(statusOf(() => requireAdmin(as('Admin')))).toBe(403);
		expect(statusOf(() => requireAdmin(as('administrator')))).toBe(403);
	});
});

describe('isAdmin', () => {
	it('is true only for the admin role', () => {
		expect(isAdmin(as('admin').locals)).toBe(true);
		expect(isAdmin(as('user').locals)).toBe(false);
		expect(isAdmin({})).toBe(false);
	});
});
