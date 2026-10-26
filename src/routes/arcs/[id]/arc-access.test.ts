/** Per-ARC access control (S2.4b) on every `/arcs/[id]` load, action and endpoint. The list is built
 *  from the file system, so a new endpoint under this directory that skips `requireArcPageAccess` fails
 *  here. Real Postgres (DML-only role), stubbed PLANTdataHUB. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { roCrateStaging } from '$lib/server/db/schema';
import { resetArcAccessCache } from '$lib/server/arc-access';
import { authenticatedLocals } from '$lib/server/test-support/brapi-event';
import { useTestDb } from '$lib/server/test-support/db-mock';
import {
	createDmlTestDb,
	hasTestDb,
	placeholderWithoutDb,
	type DmlTestDb
} from '$lib/server/test-support/dml-db';
import { stubGitlab, type GitlabStub } from '$lib/server/test-support/gitlab-stub';
import { seedOidcLogin, seedUser } from '$lib/server/test-support/oidc-seed';
import { stageArc } from '$lib/server/test-support/seed';

vi.mock('$lib/server/db', async () => (await import('$lib/server/test-support/db-mock')).dbModule);
vi.mock(
	'$lib/server/env',
	async () => (await import('$lib/server/test-support/env-mock')).envModule
);
// The page load also fetches the project as the signed-in user through better-auth's session; that
// part is not what is tested here.
vi.mock('$lib/server/auth', () => ({ auth: { api: {} } }));

const ARC = 10;

type Callable = (event: unknown) => unknown;
const modules = import.meta.glob<Record<string, unknown>>('./**/+*server.ts', { eager: true });

/** Every function SvelteKit would call for a request: `load`, each action, each HTTP verb. */
const ENTRIES: [string, Callable][] = Object.entries(modules).flatMap(([file, mod]) => {
	const entries: [string, Callable][] = [];
	if (typeof mod.load === 'function') entries.push([`${file} load`, mod.load as Callable]);
	for (const [name, fn] of Object.entries((mod.actions ?? {}) as Record<string, Callable>)) {
		entries.push([`${file} action ${name}`, fn]);
	}
	for (const verb of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
		if (typeof mod[verb] === 'function') entries.push([`${file} ${verb}`, mod[verb] as Callable]);
	}
	return entries;
});

describe('every /arcs/[id] entry point is found', () => {
	it('lists them from the file system', () => {
		const names = ENTRIES.map(([n]) => n).join('\n');
		expect(names).toContain('+page.server.ts load');
		expect(names).toContain('job/+server.ts GET');
		expect(names).toContain('ro-crate/+server.ts GET');
		expect(ENTRIES.length).toBeGreaterThanOrEqual(6);
	});
});

describe.skipIf(!hasTestDb)('ARC pages per-ARC access (stubbed PLANTdataHUB)', () => {
	let t: DmlTestDb;
	let gitlab: GitlabStub;
	let errors: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		t = await createDmlTestDb();
		useTestDb(t.db);
		for (const [id, tok] of [
			['alice', 'tok-alice'],
			['bob', 'tok-bob']
		]) {
			await seedOidcLogin(t.db, id, { accessToken: tok });
		}
		await seedUser(t.db, 'nologin');
		await stageArc(t.db, ARC, 'Group/Secret');
		await t.db
			.update(roCrateStaging)
			.set({ rawRoCrate: { secret: 'rocrate-of-a-private-arc' }, extractStatus: 'success' })
			.where(eq(roCrateStaging.arcId, ARC));
	});
	afterAll(async () => {
		useTestDb(undefined);
		await t?.drop();
	});
	beforeEach(() => {
		resetArcAccessCache();
		errors = vi.spyOn(console, 'log').mockImplementation(() => {});
		gitlab = stubGitlab();
		gitlab.acceptToken('tok-alice');
		gitlab.acceptToken('tok-bob');
		gitlab.setProject(ARC, { visibility: 'private', members: ['tok-alice'] });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		errors.mockRestore();
	});

	/** What the entry point throws (or returns) for this caller. */
	async function run(fn: Callable, userId: string | undefined, id = String(ARC)) {
		const headers: Record<string, string> = {};
		const event = {
			locals: userId ? authenticatedLocals(userId) : {},
			params: { id },
			url: new URL(`http://localhost/arcs/${id}`),
			request: new Request(`http://localhost/arcs/${id}`, { method: 'POST', body: new FormData() }),
			setHeaders: (h: Record<string, string>) => Object.assign(headers, h)
		};
		try {
			return { value: await fn(event), headers };
		} catch (e) {
			if (isHttpError(e)) return { status: e.status, message: e.body.message, headers };
			throw e;
		}
	}

	describe.each(ENTRIES)('%s', (_name, fn) => {
		it('answers a user who cannot read the ARC like an ARC that does not exist, with no data', async () => {
			const denied = await run(fn, 'bob');
			expect(denied).toMatchObject({ status: 404, message: 'Not found on PLANTdataHUB' });
			const missing = await run(fn, 'bob', '999');
			expect(missing).toEqual(denied);
			expect(JSON.stringify(denied)).not.toContain('rocrate-of-a-private-arc');
		});

		it('tells a user with an unusable login to sign in (403)', async () => {
			expect(await run(fn, 'nologin')).toMatchObject({ status: 403 });
		});

		it('answers 503 with Retry-After when PLANTdataHUB does not answer', async () => {
			gitlab.failProjects(503);
			const res = await run(fn, 'alice');
			expect(res).toMatchObject({ status: 503 });
			expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
		});

		it('refuses a malformed ARC id', async () => {
			expect(await run(fn, 'alice', 'not-a-number')).toMatchObject({ status: 404 });
		});
	});

	describe('a user who can read the ARC', () => {
		it('gets the RO-Crate and the job state', async () => {
			const crate = ENTRIES.find(([n]) => n.includes('ro-crate'))![1];
			const job = ENTRIES.find(([n]) => n.includes('job/'))![1];
			const res = (await run(crate, 'alice')).value as Response;
			expect(await res.json()).toEqual({ secret: 'rocrate-of-a-private-arc' });
			const state = (await run(job, 'alice')).value as Response;
			expect(state.status).toBe(200);
		});

		it('can queue an import', async () => {
			const extract = ENTRIES.find(([n]) => n.endsWith('action extract'))![1];
			expect((await run(extract, 'alice')).value).toMatchObject({ success: true });
		});

		it('is not signed in: 401 before anything else', async () => {
			const crate = ENTRIES.find(([n]) => n.includes('ro-crate'))![1];
			expect(await run(crate, undefined)).toMatchObject({ status: 401 });
			expect(gitlab.projectCalls()).toHaveLength(0);
		});
	});
});

placeholderWithoutDb('ARC pages per-ARC access');
