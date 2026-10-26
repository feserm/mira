import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { count, inArray } from 'drizzle-orm';
import {
	germplasm,
	location,
	observationUnit,
	requestLogs,
	study,
	trial,
	userDashboards
} from '$lib/server/db/schema';
import { resetArcAccessCache } from '$lib/server/arc-access';
import { ARC_IDS, REPOS, seedBrapiFixture } from '$lib/server/test-support/brapi-fixture';
import { stubGitlab, type GitlabStub } from '$lib/server/test-support/gitlab-stub';
import { seedOidcLogin, seedUser } from '$lib/server/test-support/oidc-seed';
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
vi.mock(
	'$lib/server/env',
	async () => (await import('$lib/server/test-support/env-mock')).envModule
);

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

describe.skipIf(!hasTestDb)('dashboard shows only ARCs the viewer can read (S2.4b)', () => {
	let t: DmlTestDb;
	let gitlab: GitlabStub;
	let errors: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
		stubGitlab({ unknownProjects: 'public' }); // the seed runs Transform, which asks NCBI
		await seedBrapiFixture(t);
		vi.unstubAllGlobals();
		await seedOidcLogin(t.db, 'alice', { accessToken: 'tok-alice' });
		await seedOidcLogin(t.db, 'bob', { accessToken: 'tok-bob' });
		await seedUser(t.db, 'nologin');
		await t.db.insert(requestLogs).values([
			{ endpoint: '/Group%2FBeta/brapi/v2/trials', method: 'GET', responseTimeMs: 5, status: 200 },
			{
				endpoint: '/Group%2FBeta/brapi/v2/germplasm/abc/mcpd',
				method: 'GET',
				responseTimeMs: 5,
				status: 200
			}
		]);
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(() => {
		resetArcAccessCache();
		errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		gitlab = stubGitlab();
		gitlab.acceptToken('tok-alice');
		gitlab.acceptToken('tok-bob');
		// alpha: private, alice is a member; beta: private, nobody; gamma: public
		gitlab.setProject(ARC_IDS.alpha, { visibility: 'private', members: ['tok-alice'] });
		gitlab.setProject(ARC_IDS.beta, { visibility: 'private', members: [] });
		gitlab.setProject(ARC_IDS.gamma, { visibility: 'public' });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		errors.mockRestore();
	});

	const view = async (userId: string, query = '') => {
		const data = (await (load as any)({
			locals: authenticatedLocals(userId),
			url: new URL(`http://x/${query}`)
		})) as any;
		const counts = Object.fromEntries(
			data.brapiTableCounts.map((c: { name: string; count: number }) => [c.name, c.count])
		) as Record<string, number>;
		return { data, counts, repos: data.servers.map((s: { alias: string }) => s.alias) as string[] };
	};
	const rows = async (
		table: typeof trial | typeof study | typeof observationUnit,
		arcIds: number[]
	) => (await t.db.select({ n: count() }).from(table).where(inArray(table.arcId, arcIds)))[0].n;

	it('lists and counts exactly the ARCs the viewer can read', async () => {
		const alice = await view('alice');
		expect(alice.repos).toEqual([REPOS.alpha, REPOS.gamma]);
		expect(alice.counts.Trials).toBe(await rows(trial, [ARC_IDS.alpha, ARC_IDS.gamma]));
		expect(alice.counts.Studies).toBe(await rows(study, [ARC_IDS.alpha, ARC_IDS.gamma]));

		const bob = await view('bob'); // a member of nothing: only the public ARC
		expect(bob.repos).toEqual([REPOS.gamma]);
		expect(bob.counts.Trials).toBe(await rows(trial, [ARC_IDS.gamma]));
		expect(bob.counts['Observation units']).toBe(await rows(observationUnit, [ARC_IDS.gamma]));
	});

	it('counts shared tables only for rows an accessible ARC references', async () => {
		const distinct = async (arcIds: number[], column: 'germplasmId' | 'locationId') =>
			new Set(
				(
					await t.db
						.select({
							v: column === 'germplasmId' ? observationUnit.germplasmId : study.locationId
						})
						.from(column === 'germplasmId' ? observationUnit : study)
						.where(inArray(column === 'germplasmId' ? observationUnit.arcId : study.arcId, arcIds))
				)
					.map((r) => r.v)
					.filter(Boolean)
			).size;
		const [totalGermplasm] = await t.db.select({ n: count() }).from(germplasm);
		const [totalLocations] = await t.db.select({ n: count() }).from(location);

		const bob = await view('bob'); // only gamma
		expect(bob.counts.Germplasm).toBe(await distinct([ARC_IDS.gamma], 'germplasmId'));
		expect(bob.counts.Locations).toBe(await distinct([ARC_IDS.gamma], 'locationId'));
		// the fixture's other ARCs bring germplasm and a site of their own: a global count would be higher
		expect(bob.counts.Germplasm).toBeLessThan(totalGermplasm.n);
		expect(bob.counts.Locations).toBeLessThan(totalLocations.n);

		const alice = await view('alice');
		const both = [ARC_IDS.alpha, ARC_IDS.gamma];
		expect(alice.counts.Germplasm).toBe(await distinct(both, 'germplasmId'));
		expect(alice.counts.Germplasm).toBeLessThan(totalGermplasm.n);

		// no global count of a table that cannot be attributed to an ARC is ever shown
		expect(Object.keys(bob.counts)).not.toContain('People');
		expect(Object.keys(bob.counts)).not.toContain('Traits');
	});

	it('ignores ?server= for an ARC the viewer cannot read, and honours it for one they can', async () => {
		const hidden = await view('bob', `?server=${ARC_IDS.beta}`);
		expect(hidden.data.selectedServerId).toBeNull();
		expect(hidden.counts).toEqual((await view('bob')).counts);
		const own = await view('alice', `?server=${ARC_IDS.alpha}`);
		expect(own.data.selectedServerId).toBe(ARC_IDS.alpha);
		expect(own.counts.Trials).toBe(await rows(trial, [ARC_IDS.alpha]));
	});

	it('shows nothing, and says why, when PLANTdataHUB cannot be asked (fail closed)', async () => {
		gitlab.failProjects(503);
		const down = await view('alice');
		expect(down.repos).toEqual([]);
		expect(down.data.arcNotice).toMatch(/did not answer/);
		expect(Object.values(down.counts).every((n) => n === 0)).toBe(true);
	});

	it('a viewer whose login is dead still sees the public ARCs, and is told to sign in', async () => {
		const res = await view('nologin');
		expect(res.repos).toEqual([REPOS.gamma]);
		expect(res.data.arcNotice).toMatch(/Sign in to MIRA again/);
	});

	it('the endpoint widget carries no repo slug, so a hidden ARC is not named', async () => {
		const { data } = await view('bob');
		expect(data.analytics.endpointPopularity.length).toBeGreaterThan(0);
		expect(JSON.stringify(data.analytics)).not.toMatch(/beta/i);
		expect(JSON.stringify(data.analytics)).not.toContain('Group');
	});
});

placeholderWithoutDb('dashboard access');
