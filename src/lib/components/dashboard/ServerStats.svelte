<script lang="ts">
	import { goto } from '$app/navigation';
	import type { BrapiTableCount } from '$lib/server/db/brapi-analytics';

	type Server = {
		id: number;
		alias: string;
	};

	let {
		counts = [],
		servers = [],
		selectedServerId = null
	}: {
		counts?: BrapiTableCount[];
		servers?: Server[];
		selectedServerId?: number | null;
	} = $props();

	async function selectServer(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		await goto(value ? `?server=${encodeURIComponent(value)}` : '?', {
			keepFocus: true,
			replaceState: true
		});
	}
</script>

<section
	class="flex h-full min-w-0 flex-col text-base-content"
	aria-labelledby="server-stats-title"
>
	<h2 id="server-stats-title" class="sr-only">BrAPI database contents</h2>
	<label class="mb-3 flex items-center gap-2 text-sm">
		<span class="shrink-0 text-base-content/60">Server</span>
		<select
			class="select min-w-0 flex-1 select-sm"
			aria-label="Filter BrAPI counts by server"
			value={selectedServerId ?? ''}
			onchange={selectServer}
		>
			<option value="">All servers</option>
			{#each servers as server (server.id)}
				<option value={server.id}>{server.alias}</option>
			{/each}
		</select>
	</label>
	<div class="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto pb-8 sm:grid-cols-3">
		{#each counts as item (item.name)}
			<div class="rounded-box border border-base-content/10 bg-base-200/50 p-3">
				<div class="text-2xl font-semibold tabular-nums">{item.count}</div>
				<div class="text-xs text-base-content/60">{item.name}</div>
			</div>
		{/each}
	</div>
</section>
