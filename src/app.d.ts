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
		}

		// interface Error {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
