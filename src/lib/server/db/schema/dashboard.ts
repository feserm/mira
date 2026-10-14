import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';

export type DashboardLayoutItem = {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	type: string;
};

export const userDashboards = pgTable('user_dashboards', {
	userId: text('user_id').primaryKey(),
	layout: jsonb('layout').$type<DashboardLayoutItem[]>().notNull().default([])
});
