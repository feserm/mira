import { config } from '$lib/server/env';
import { betterAuth } from 'better-auth/minimal';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import { getRequestEvent } from '$app/server';
import { baseAuthOptions, oidcPlugin } from '$lib/server/auth-options';

export const auth = betterAuth({
	...baseAuthOptions,
	// better-auth throws on a missing secret in production mode, and `vite build` imports this
	// module with no env present. The placeholder is never used: the build only analyses the code.
	secret: building ? 'build-time-placeholder-secret-not-used-at-runtime' : config.authSecret,
	plugins: [
		oidcPlugin(),
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
