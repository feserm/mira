<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import IconLayoutGrid from '@tabler/icons-svelte-runes/icons/layout-grid';
	import IconTable from '@tabler/icons-svelte-runes/icons/table';
	import { visibilityBadgeClass } from '$lib/utils/gitlab';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const VIEW_STORAGE_KEY = 'arcs:view';

	type View = 'grid' | 'table';

	function loadStoredView(): View {
		if (!browser) return 'grid';
		return localStorage.getItem(VIEW_STORAGE_KEY) === 'table' ? 'table' : 'grid';
	}

	let view = $state<View>(loadStoredView());

	function setView(next: View) {
		view = next;
		if (browser) localStorage.setItem(VIEW_STORAGE_KEY, next);
	}

	function formatDate(iso: string) {
		return new Date(iso).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}
</script>

<svelte:head><title>ARCs · Mira</title></svelte:head>

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
	<div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<h1 class="text-2xl font-bold">Annotated Research Contexts</h1>
		<div class="flex gap-2">
			<form method="GET" class="flex gap-2">
				<input
					type="search"
					name="q"
					value={data.search}
					placeholder="Search ARCs…"
					class="input-bordered input w-full sm:w-72"
				/>
				<button type="submit" class="btn btn-primary">Search</button>
			</form>
			<div class="join" role="group" aria-label="Layout">
				<button
					type="button"
					class="btn join-item btn-sm {view === 'grid' ? 'btn-active' : ''}"
					aria-pressed={view === 'grid'}
					aria-label="Grid view"
					title="Grid view"
					onclick={() => setView('grid')}
				>
					<IconLayoutGrid size={16} />
				</button>
				<button
					type="button"
					class="btn join-item btn-sm {view === 'table' ? 'btn-active' : ''}"
					aria-pressed={view === 'table'}
					aria-label="Table view"
					title="Table view"
					onclick={() => setView('table')}
				>
					<IconTable size={16} />
				</button>
			</div>
		</div>
	</div>

	{#if data.arcs.length === 0}
		<div class="hero rounded-box bg-base-100 py-16">
			<div class="hero-content text-center">
				<p class="text-base-content/70">
					No ARCs found{data.search ? ` for “${data.search}”` : ''}.
				</p>
			</div>
		</div>
	{:else}
		{#if view === 'grid'}
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.arcs as arc (arc.id)}
					<a
						href={resolve('/arcs/[id]', { id: String(arc.id) })}
						class="card bg-base-100 shadow-sm transition hover:shadow-md"
					>
						<div class="card-body">
							<div class="flex items-start gap-3">
								{#if arc.avatar_url}
									<div class="avatar">
										<div class="w-10 rounded">
											<img src={arc.avatar_url} alt="" />
										</div>
									</div>
								{/if}
								<div class="min-w-0">
									<h2 class="card-title text-base leading-tight wrap-break-word">{arc.name}</h2>
									<p class="truncate text-xs text-base-content/60">{arc.namespace.full_path}</p>
								</div>
							</div>
							{#if arc.description}
								<p class="mt-2 line-clamp-2 text-sm text-base-content/70">{arc.description}</p>
							{/if}
							<div class="mt-3 card-actions items-center justify-between">
								<span class="badge badge-sm {visibilityBadgeClass(arc.visibility)}"
									>{arc.visibility}</span
								>
								<span class="text-xs text-base-content/50">
									Updated {formatDate(arc.last_activity_at)}
								</span>
							</div>
						</div>
					</a>
				{/each}
			</div>
		{:else}
			<div class="overflow-x-auto rounded-box bg-base-100 shadow-sm">
				<table class="table">
					<thead>
						<tr>
							<th>Name</th>
							<th>Description</th>
							<th>Visibility</th>
							<th>Updated</th>
						</tr>
					</thead>
					<tbody>
						{#each data.arcs as arc (arc.id)}
							<tr
								class="hover cursor-pointer"
								tabindex="0"
								onclick={() => goto(resolve('/arcs/[id]', { id: String(arc.id) }))}
								onkeydown={(e) => {
									if (e.key === 'Enter') goto(resolve('/arcs/[id]', { id: String(arc.id) }));
								}}
							>
								<td>
									<div class="flex items-center gap-3">
										<div class="avatar">
											<div class="mask h-12 w-12 mask-squircle">
												{#if arc.avatar_url}
													<img src={arc.avatar_url} alt="" />
												{:else}
													<div class="h-16 w-16 skeleton"></div>
												{/if}
											</div>
										</div>
										<div>
											<div class="font-bold max-w-[25ch] truncate" title="{arc.name}">
  												{arc.name}
											</div>
											<div class="text-sm opacity-50">{arc.namespace.full_path}</div>
										</div>
									</div>
								</td>
								<td class="max-w-xs truncate text-sm text-base-content/70">
									{arc.description ?? ''}
								</td>
								<td
									><span class="badge badge-sm {visibilityBadgeClass(arc.visibility)}"
										>{arc.visibility}</span
									></td
								>
								<td class="text-sm text-base-content/50">{formatDate(arc.last_activity_at)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if data.pagination.totalPages > 1}
			<div class="mt-8 flex items-center justify-center gap-4">
				<div class="join">
					<a
						href="{resolve('/arcs')}?q={encodeURIComponent(data.search)}&page={data.pagination
							.page - 1}"
						class="btn join-item btn-sm {data.pagination.page <= 1 ? 'btn-disabled' : ''}"
						aria-disabled={data.pagination.page <= 1}
					>
						« Prev
					</a>
					<span class="btn btn-disabled join-item btn-sm">
						Page {data.pagination.page} of {data.pagination.totalPages}
					</span>
					<a
						href="{resolve('/arcs')}?q={encodeURIComponent(data.search)}&page={data.pagination
							.page + 1}"
						class="btn join-item btn-sm {data.pagination.page >= data.pagination.totalPages
							? 'btn-disabled'
							: ''}"
						aria-disabled={data.pagination.page >= data.pagination.totalPages}
					>
						Next »
					</a>
				</div>
			</div>
		{/if}
	{/if}
</div>
