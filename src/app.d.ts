import type { Session, User } from 'better-auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			// `role` comes from the better-auth admin plugin ('admin' | 'user'; null before the first sign-in
			// after the column was added). Use `isAdmin` / `requireAdmin` from `$lib/server/auth-guard`.
			user?: User & { role?: string | null };
			session?: Session;
			// Set by `authenticateBrapi` (BrAPI routes only): a session cookie or an API token. S2.4b checks GitLab
			// access for the token owner, so it reads `user` the same way for both.
			authMethod?: 'session' | 'token';
		}

		// BrAPI errors also carry the standard `metadata.status` list (see `brapi/auth.ts`).
		interface Error {
			message: string;
			metadata?: { datafiles: unknown[]; status: { message: string; messageType: string }[] };
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
