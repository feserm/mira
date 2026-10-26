/** A stand-in for PLANTdataHUB: the OIDC endpoints (discovery and the refresh grant) and
 *  `GET /api/v4/projects/:id`, installed as the global `fetch`. It counts refresh grants and project
 *  calls and never exposes the tokens it hands out beyond what the caller passes in. Call
 *  `vi.unstubAllGlobals()` afterwards.
 *
 *  Projects follow GitLab's rules for what the access check relies on: anonymous callers see only
 *  `public` projects (404 otherwise); a bearer token GitLab does not know is a 401; a known token sees
 *  `public` and `internal` projects and `private` ones it is a member of (404 otherwise). */
import { vi } from 'vitest';

export type Visibility = 'public' | 'internal' | 'private';

/** How the project endpoint misbehaves: an HTTP status for every call, or `'network'` (the connection
 *  fails), or `'hang'` (never answers; the caller's timeout must cut it off). */
export type ProjectFault = number | 'network' | 'hang';

export interface GitlabStub {
	/** how many `grant_type=refresh_token` requests reached the token endpoint */
	refreshCalls(): number;
	/** Creates or changes a project. `members` are access tokens that belong to it. */
	setProject(id: number, project: { visibility: Visibility; members?: string[] }): void;
	/** Tells the stub which access tokens exist (a token it does not know is a 401). */
	acceptToken(token: string): void;
	rejectToken(token: string): void;
	/** Every project call so far, oldest first: the project id and the token sent (undefined: anonymous). */
	projectCalls(): { id: number; token: string | undefined }[];
	/** Every project call from now on fails this way; `undefined` restores normal answers. */
	failProjects(fault: ProjectFault | undefined): void;
}

export interface GitlabStubOptions {
	accessToken?: string;
	refreshToken?: string;
	/** Projects that exist without a `setProject` call: `'public'` (for suites that are not about
	 *  access) or none (404 for everyone). */
	unknownProjects?: 'public';
	/** GitLab semantics: a refresh token works once. The grant answers 400 `invalid_grant` for any
	 *  refresh token but the one issued last (initially this value), and hands out a new one each time. */
	singleUseFrom?: string;
	/** how long the token endpoint takes to answer, so overlapping refreshes really overlap */
	delayMs?: number;
}

export function stubGitlab(opts: GitlabStubOptions = {}): GitlabStub {
	const base = 'https://gitlab.test';
	const accessToken = opts.accessToken ?? 'glpat-fresh';
	const refreshTokenValue = opts.refreshToken ?? 'glrt-next';
	let refreshes = 0;
	const projects = new Map<number, { visibility: Visibility; members: Set<string> }>();
	const tokens = new Set<string>([accessToken]);
	const calls: { id: number; token: string | undefined }[] = [];
	let fault: ProjectFault | undefined;
	let valid = opts.singleUseFrom;
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `${base}/.well-known/openid-configuration`) {
			return json({
				issuer: base,
				authorization_endpoint: `${base}/oauth/authorize`,
				token_endpoint: `${base}/oauth/token`,
				userinfo_endpoint: `${base}/oauth/userinfo`,
				jwks_uri: `${base}/oauth/discovery/keys`
			});
		}
		const projectMatch = new RegExp(`^${base}/api/v4/projects/(\\d+)(?:\\?.*)?$`).exec(url);
		if (projectMatch) {
			const id = Number(projectMatch[1]);
			const auth = new Headers(init?.headers).get('authorization');
			const token = auth?.replace(/^Bearer /, '');
			calls.push({ id, token });
			if (fault === 'network') throw new TypeError('fetch failed');
			if (fault === 'hang') {
				return new Promise<Response>((_, reject) =>
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
				);
			}
			if (fault !== undefined) return json({ message: 'fault' }, fault);
			if (token !== undefined && !tokens.has(token))
				return json({ message: '401 Unauthorized' }, 401);
			const project =
				projects.get(id) ??
				(opts.unknownProjects === 'public'
					? { visibility: 'public' as const, members: new Set<string>() }
					: undefined);
			const visible =
				project &&
				(project.visibility === 'public' ||
					(token !== undefined &&
						(project.visibility === 'internal' || project.members.has(token))));
			if (!project || !visible) return json({ message: '404 Project Not Found' }, 404);
			return json({ id, visibility: project.visibility, path: `project-${id}` });
		}
		if (url === `${base}/oauth/token`) {
			const body = String(init?.body ?? (input instanceof Request ? await input.text() : ''));
			const form = new URLSearchParams(body);
			if (form.get('grant_type') === 'refresh_token') refreshes++;
			if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
			let refreshToken = refreshTokenValue;
			if (valid !== undefined) {
				if (form.get('refresh_token') !== valid) return json({ error: 'invalid_grant' }, 400);
				refreshToken = valid = `${refreshTokenValue}-${refreshes}`;
			}
			return json({
				access_token: accessToken,
				refresh_token: refreshToken,
				token_type: 'Bearer',
				expires_in: 7200,
				scope: 'openid profile email read_api'
			});
		}
		// anything else (NCBI, ...) is unreachable, as in the other suites
		return new Response('unavailable', { status: 500 });
	});

	return {
		refreshCalls: () => refreshes,
		setProject: (id, p) =>
			void projects.set(id, { visibility: p.visibility, members: new Set(p.members) }),
		acceptToken: (token) => void tokens.add(token),
		rejectToken: (token) => void tokens.delete(token),
		projectCalls: () => [...calls],
		failProjects: (f) => void (fault = f)
	};
}
