import { error, type RequestEvent } from '@sveltejs/kit';
import { ADMIN_ROLE } from '$lib/server/roles';

type Locals = Pick<RequestEvent['locals'], 'user'>;

/** Whether the signed-in user is an admin. Admin is an operations role (dashboard, request metrics),
 *  not data access: who may see an ARC is decided by GitLab membership (docs/deployment-sprint-plan.md,
 *  decision 1). */
export function isAdmin(locals: Locals): boolean {
	return locals.user?.role === ADMIN_ROLE;
}

/** 401 when nobody is signed in, 403 for a signed-in user who is not an admin. Returns the admin. */
export function requireAdmin(event: { locals: Locals }): NonNullable<Locals['user']> {
	const user = event.locals.user;
	if (!user) error(401, 'Not signed in');
	if (user.role !== ADMIN_ROLE) error(403, 'This page is for administrators');
	return user;
}
