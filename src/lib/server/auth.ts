import { config } from '$lib/server/env';
import { betterAuth } from 'better-auth/minimal';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import { getRequestEvent } from '$app/server';
import { baseAuthOptions, sharedPlugins } from '$lib/server/auth-options';
import { authRateLimitOptions } from '$lib/server/auth-rate-limit';

export const auth = betterAuth({
	...baseAuthOptions,
	...authRateLimitOptions,
	// better-auth throws on a missing secret in production mode, and `vite build` imports this
	// module with no env present. The placeholder is never used: the build only analyses the code.
	secret: building ? 'build-time-placeholder-secret-not-used-at-runtime' : config.authSecret,
	plugins: [
		...sharedPlugins(),
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
