import { fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth-guard';
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

/** Widgets that show data only admins may see. */
const ADMIN_WIDGETS = new Set<string>(['UserStats']);

const withoutAdminWidgets = (layout: DashboardLayoutItem[], admin: boolean) =>
	admin ? layout : layout.filter((item) => !ADMIN_WIDGETS.has(item.type));

export const load: PageServerLoad = async ({ locals, url }) => {
	// Anonymous visitors get the landing text; every signed-in user gets the dashboard. Only the
	// widgets in `ADMIN_WIDGETS` (the user list) are for admins: their data is not loaded for anyone else.
	if (!locals.user) return { layout: defaultLayout, authenticated: false };
	const admin = isAdmin(locals);

	const rawServerId = url.searchParams.get('server');
	const requestedServerId = rawServerId === null ? undefined : Number(rawServerId);
	const selectedServerId =
		requestedServerId !== undefined && Number.isInteger(requestedServerId)
			? requestedServerId
			: undefined;

	const [[dashboard], [analytics, brapiTableCounts, servers, users]] = await Promise.all([
		db.select().from(userDashboards).where(eq(userDashboards.userId, locals.user.id)),
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
			admin
				? db
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
				: Promise.resolve([])
		])
	]);

	return {
		layout: withoutAdminWidgets(dashboard?.layout ?? defaultLayout, admin),
		admin,
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

		const data = await request.formData();
		const rawLayout = data.get('layout');
		if (typeof rawLayout !== 'string') {
			return fail(400, { success: false, message: 'A layout is required' });
		}

		let layout: DashboardLayoutItem[];
		try {
			const parsed: unknown = JSON.parse(rawLayout);
			if (!Array.isArray(parsed)) throw new Error('Layout must be an array');
			layout = withoutAdminWidgets(parsed as DashboardLayoutItem[], isAdmin(locals));
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
