import { fail } from '@sveltejs/kit';
import { isAdmin, requireAdmin } from '$lib/server/auth-guard';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	account,
	roCrateStaging,
	user,
	userDashboards,
	type DashboardLayoutItem
} from '$lib/server/db/schema';
import { getDashboardAnalytics } from '$lib/server/db/request-analytics';
import { getBrapiTableCounts } from '$lib/server/db/brapi-analytics';
import type { Actions, PageServerLoad } from './$types';

const defaultLayout: DashboardLayoutItem[] = [
	{ id: 'revenue', x: 0, y: 0, w: 4, h: 3, type: 'RevenueChart' },
	{ id: 'users', x: 4, y: 0, w: 2, h: 3, type: 'UserStats' },
	{ id: 'server-stats', x: 0, y: 3, w: 4, h: 3, type: 'ServerStats' }
];

export const load: PageServerLoad = async ({ locals, url }) => {
	// Anonymous visitors get the landing text; everything below is the operations dashboard (request
	// metrics, table counts, user list), which only admins may see.
	if (!locals.user) return { layout: defaultLayout, authenticated: false };
	const admin = requireAdmin({ locals });

	const rawServerId = url.searchParams.get('server');
	const requestedServerId = rawServerId === null ? undefined : Number(rawServerId);
	const selectedServerId =
		requestedServerId !== undefined && Number.isInteger(requestedServerId)
			? requestedServerId
			: undefined;

	const [[dashboard], [analytics, brapiTableCounts, servers, users]] = await Promise.all([
		db.select().from(userDashboards).where(eq(userDashboards.userId, admin.id)),
		Promise.all([
			getDashboardAnalytics(),
			getBrapiTableCounts(selectedServerId),
			db
				.select({
					id: roCrateStaging.arcId,
					alias: roCrateStaging.path
				})
				.from(roCrateStaging)
				.orderBy(roCrateStaging.path),
			db
				.select({
					id: user.id,
					name: user.name,
					email: user.email,
					role: user.role,
					lastAccountUpdate: sql<Date | null>`max(${account.updatedAt})`
				})
				.from(user)
				.leftJoin(account, eq(account.userId, user.id))
				.groupBy(user.id)
				.orderBy(user.name)
		])
	]);

	return {
		layout: dashboard?.layout ?? defaultLayout,
		authenticated: true,
		analytics,
		brapiTableCounts,
		selectedServerId: selectedServerId ?? null,
		servers,
		users
	};
};

export const actions: Actions = {
	saveLayout: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { success: false, message: 'Not signed in' });
		if (!isAdmin(locals)) return fail(403, { success: false, message: 'Administrators only' });

		const data = await request.formData();
		const rawLayout = data.get('layout');
		if (typeof rawLayout !== 'string') {
			return fail(400, { success: false, message: 'A layout is required' });
		}

		let layout: DashboardLayoutItem[];
		try {
			const parsed: unknown = JSON.parse(rawLayout);
			if (!Array.isArray(parsed)) throw new Error('Layout must be an array');
			layout = parsed as DashboardLayoutItem[];
		} catch {
			return fail(400, { success: false, message: 'Invalid layout' });
		}

		await db.insert(userDashboards).values({ userId: locals.user.id, layout }).onConflictDoUpdate({
			target: userDashboards.userId,
			set: { layout }
		});

		return { success: true };
	}
};
