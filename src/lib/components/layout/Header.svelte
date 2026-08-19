<script lang="ts">
	import { resolve } from '$app/paths';
	import { authClient } from '$lib/auth-client';

	const session = authClient.useSession();

	function login() {
		authClient.signIn.oauth2({ providerId: 'oidc', callbackURL: '/' });
	}

	function logout() {
		authClient.signOut();
	}

	function initials(name: string | null | undefined, email: string) {
		const source = name?.trim() || email;
		return source.charAt(0).toUpperCase();
	}
</script>

<div class="navbar bg-base-100 px-4 shadow-sm sm:px-6">
	<div class="navbar-start gap-4">
		<span class="text-xl font-semibold tracking-tight">Mira</span>
		{#if $session.data}
			<a href={resolve('/arcs')} class="link text-sm font-medium link-hover">ARCs</a>
		{/if}
	</div>
	<div class="navbar-end">
		{#if $session.isPending}
			<span class="loading loading-sm loading-spinner"></span>
		{:else if $session.data}
			<div class="dropdown dropdown-end">
				<div tabindex="0" role="button" class="btn avatar avatar-placeholder btn-circle btn-ghost">
					<div class="w-10 rounded-full bg-neutral text-neutral-content">
						<span>{initials($session.data.user.name, $session.data.user.email)}</span>
					</div>
				</div>
				<ul
					tabindex="0"
					role="menu"
					class="menu dropdown-content z-1 mt-3 w-56 rounded-box bg-base-100 p-2 shadow-lg"
				>
					<li class="menu-title">{$session.data.user.name ?? $session.data.user.email}</li>
					<li><button onclick={logout}>Log out</button></li>
				</ul>
			</div>
		{:else}
			<button class="btn btn-primary btn-sm" onclick={login}>Log in</button>
		{/if}
	</div>
</div>
