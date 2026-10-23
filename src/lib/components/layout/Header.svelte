<script lang="ts">
	import { resolve } from '$app/paths';
	import { authClient } from '$lib/auth-client';
	import logo from '$lib/assets/mira-primary-logo.png';

	const session = authClient.useSession();

	function login() {
		authClient.signIn.oauth2({ providerId: 'oidc', callbackURL: '/arcs' });
	}

	function logout() {
		authClient.signOut();
	}

	function initials(name: string | null | undefined, email: string) {
		const source = name?.trim() || email;
		return source.charAt(0).toUpperCase();
	}
</script>

<header
	class="navbar sticky top-0 z-50 border-b border-base-200 bg-base-100/80 px-4 backdrop-blur-md sm:px-8"
>
	<div class="navbar-start gap-6">
		<a
			aria-label="MIRA"
			href={resolve('/')}
			class="text-xl font-bold tracking-tight text-base-content transition-opacity hover:opacity-80"
		>
			<img alt="MIRA" src={logo} class="h-8 w-8" />
		</a>

		{#if $session.data}
			<nav class="flex items-center gap-1">
				<a href={resolve('/arcs')} class="btn btn-ghost font-medium btn-sm"> ARCs </a>
			</nav>
		{/if}
	</div>

	<div class="navbar-end">
		{#if $session.isPending}
			<span class="loading loading-md loading-spinner text-primary"></span>
		{:else if $session.data}
			<div class="dropdown dropdown-end">
				<div
					tabindex="0"
					role="button"
					class="placeholder btn avatar btn-circle btn-ghost transition-all hover:ring-2 hover:ring-primary/20"
				>
					<div
						class="flex w-10 items-center justify-center rounded-full bg-primary font-semibold text-primary-content"
					>
						{#if $session.data.user.image}
							<img
								alt={$session.data.user.name ?? $session.data.user.email}
								src={$session.data.user.image}
								class="h-full w-full rounded-full object-cover"
							/>
						{:else}
							<span>{initials($session.data.user.name, $session.data.user.email)}</span>
						{/if}
					</div>
				</div>
				<div
					tabindex="0"
					role="menu"
					class="dropdown-content z-1 mt-3 w-60 rounded-xl bg-base-100 p-2 shadow-xl ring-1 ring-base-content/5"
				>
					<div class="border-b border-base-200 px-3 py-2">
						<p class="text-[10px] font-semibold tracking-wider text-base-content/60 uppercase">
							Signed in as
						</p>
						<p class="truncate text-sm font-medium text-base-content">
							{$session.data.user.name ?? $session.data.user.email}
						</p>
					</div>
					<ul class="menu w-full p-0 pt-1">
						<li class="w-full">
							<button
								onclick={logout}
								class="w-full text-error hover:bg-error/10 focus:bg-error/10"
							>
								Log out
							</button>
						</li>
					</ul>
				</div>
			</div>
		{:else}
			<button class="btn px-5 btn-primary btn-sm" onclick={login}> Log in </button>
		{/if}
	</div>
</header>
