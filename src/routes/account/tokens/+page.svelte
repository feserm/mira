<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let copied = $state(false);

	async function copy(token: string) {
		try {
			await navigator.clipboard.writeText(token);
			copied = true;
		} catch {
			copied = false;
		}
	}

	const format = (d: Date | null) => (d ? d.toLocaleString() : '–');
	const choiceLabel = (days: number | null) => (days === null ? 'Never expires' : `${days} days`);
	const statusClass = { active: 'badge-success', expired: 'badge-warning', revoked: 'badge-error' };
</script>

<svelte:head><title>API tokens · Mira</title></svelte:head>

<div class="mx-auto max-w-4xl px-4 py-8 sm:px-6">
	<h1 class="mb-2 text-2xl font-bold">API tokens</h1>
	<p class="mb-6 text-base-content/70">
		A token lets a script or another BrAPI client read the data you may read. Send it as
		<code>Authorization: Bearer &lt;token&gt;</code>. Tokens are read-only, can be revoked at any
		time, and are shown only once.
	</p>

	{#if form && 'created' in form && form.created}
		<div class="mb-6 alert alert-vertical alert-success sm:alert-horizontal" role="status">
			<div class="w-full min-w-0">
				<p class="font-semibold">
					Token “{form.created.name}” created. Copy it now: it is not shown again.
				</p>
				<div class="mt-2 flex items-center gap-2">
					<code class="min-w-0 flex-1 rounded bg-base-100 px-2 py-1 break-all text-base-content"
						>{form.created.token}</code
					>
					<button type="button" class="btn btn-sm" onclick={() => copy(form.created.token)}>
						{copied ? 'Copied' : 'Copy'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<form
		method="POST"
		action="?/create"
		class="mb-8 flex flex-col gap-3 rounded-box bg-base-100 p-4 sm:flex-row sm:items-end"
		use:enhance={() => {
			copied = false;
			return async ({ update }) => {
				await update();
			};
		}}
	>
		<label class="form-control flex-1">
			<span class="label-text mb-1">Name</span>
			<input
				name="name"
				required
				maxlength="80"
				placeholder="e.g. analysis notebook"
				class="input-bordered input w-full"
				value={form && 'name' in form && form.name ? form.name : ''}
			/>
		</label>
		<label class="form-control">
			<span class="label-text mb-1">Lifetime</span>
			<select name="expiresInDays" class="select-bordered select">
				{#each data.expiryChoices as days (days)}
					<option value={days ?? 'never'} selected={days === data.defaultExpiryDays}>
						{choiceLabel(days)}
					</option>
				{/each}
			</select>
		</label>
		<button class="btn btn-primary">Create token</button>
	</form>
	{#if form && 'error' in form && form.error}
		<p class="-mt-5 mb-6 text-error" role="alert">{form.error}</p>
	{/if}

	<h2 class="mb-2 text-lg font-semibold">Your tokens</h2>
	{#if data.tokens.length === 0}
		<p class="text-base-content/70">You have no tokens yet.</p>
	{:else}
		<div class="overflow-x-auto rounded-box bg-base-100">
			<table class="table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Token</th>
						<th>Created</th>
						<th>Expires</th>
						<th>Last used</th>
						<th>Status</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.tokens as token (token.id)}
						<tr>
							<td>{token.name}</td>
							<td><code>{token.prefix}…</code></td>
							<td>{format(token.createdAt)}</td>
							<td>{token.expiresAt ? format(token.expiresAt) : 'never'}</td>
							<td>{format(token.lastUsedAt)}</td>
							<td><span class="badge {statusClass[token.status]}">{token.status}</span></td>
							<td class="text-right">
								{#if token.status === 'active'}
									<form method="POST" action="?/revoke" use:enhance>
										<input type="hidden" name="id" value={token.id} />
										<button class="btn btn-ghost text-error btn-xs">Revoke</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
