import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import {
	countActiveTokens,
	createApiToken,
	DEFAULT_EXPIRY_DAYS,
	EXPIRY_CHOICES,
	listApiTokens,
	MAX_ACTIVE_TOKENS_PER_USER,
	revokeApiToken,
	tokenStatus
} from '$lib/server/api-token';
import { isDbId } from '$lib/server/brapi/response';
import type { Actions, PageServerLoad } from './$types';

const MAX_NAME_LENGTH = 80;

/** Token management is for a person in a browser: the session cookie only. A request that carries an
 *  `Authorization` header is refused even if it also has a cookie, so a leaked API token can never be
 *  used to mint or revoke tokens. */
function sessionUser(event: Pick<RequestEvent, 'locals' | 'request'>) {
	if (event.request.headers.has('authorization')) error(401, 'API tokens cannot manage API tokens');
	if (!event.locals.user) error(401, 'Not signed in');
	return event.locals.user;
}

export const load: PageServerLoad = async (event) => {
	if (event.request.headers.has('authorization')) sessionUser(event);
	if (!event.locals.user) redirect(303, '/');

	const now = new Date();
	const tokens = (await listApiTokens(event.locals.user.id)).map((t) => ({
		...t,
		status: tokenStatus(t, now)
	}));
	return {
		tokens,
		expiryChoices: EXPIRY_CHOICES,
		defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
		maxActive: MAX_ACTIVE_TOKENS_PER_USER
	};
};

export const actions: Actions = {
	create: async (event) => {
		const user = sessionUser(event);
		// The secret appears once, in this response: keep it out of any cache.
		event.setHeaders({ 'cache-control': 'no-store' });

		const form = await event.request.formData();
		const name = String(form.get('name') ?? '').trim();
		const expiry = String(form.get('expiresInDays') ?? '');

		if (!name || name.length > MAX_NAME_LENGTH)
			return fail(400, {
				error: `Give the token a name of 1 to ${MAX_NAME_LENGTH} characters.`,
				name
			});

		const days = expiry === 'never' ? null : Number(expiry);
		if (!EXPIRY_CHOICES.some((c) => c === days))
			return fail(400, { error: 'Choose one of the listed lifetimes.', name });

		if ((await countActiveTokens(user.id)) >= MAX_ACTIVE_TOKENS_PER_USER)
			return fail(400, {
				error: `You already have ${MAX_ACTIVE_TOKENS_PER_USER} active tokens. Revoke one first.`,
				name
			});

		const { token, info } = await createApiToken(user.id, name, days);
		return { created: { token, name: info.name, prefix: info.prefix, expiresAt: info.expiresAt } };
	},

	revoke: async (event) => {
		const user = sessionUser(event);
		const id = String((await event.request.formData()).get('id') ?? '');
		// Someone else's token and a nonexistent one look the same.
		if (!isDbId(id) || !(await revokeApiToken(user.id, id))) error(404, 'No such token');
		return { revoked: id };
	}
};
