<script lang="ts">
	type Endpoint = {
		path: string;
		method: string;
		requests: number;
	};

	let { endpoints = [] }: { endpoints?: Endpoint[] } = $props();

	const totalRequests = $derived(
		endpoints.reduce((total, endpoint) => total + endpoint.requests, 0)
	);
	const maximumRequests = $derived(Math.max(...endpoints.map((endpoint) => endpoint.requests), 1));
</script>

<section
	class="flex h-full min-w-0 flex-col text-base-content"
	aria-labelledby="endpoint-popularity-title"
>
	<div class="mb-4 flex items-end gap-2 border-b border-base-content/10 pb-4">
		<strong class="text-3xl leading-none">{totalRequests.toLocaleString()}</strong>
		<span class="pb-0.5 text-xs text-base-content/60">total requests</span>
	</div>

	<div class="min-h-0 flex-1 space-y-3" aria-label="BrAPI endpoints ranked by request count">
		{#each endpoints as endpoint, index (`${endpoint.method}-${endpoint.path}`)}
			<div class="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2">
				<span
					class={`mr-1 badge inline-flex h-7 w-7 items-center justify-center rounded-full p-0 text-xs ${
						index + 1 === 1
							? 'bg-amber-200/60 text-amber-900'
							: index + 1 === 2
								? 'bg-slate-200/80 text-slate-700'
								: index + 1 === 3
									? 'bg-orange-200/60 text-orange-900'
									: 'badge-base-200/10'
					}`}>{index + 1}</span
				>
				<div class="min-w-0">
					<div class="mb-1 flex min-w-0 items-center gap-1.5">
						<em
							class={`inline-block w-fit shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-bold not-italic max-[240px]:text-[8px] ${
								endpoint.method === 'GET'
									? 'bg-info/10 text-info'
									: endpoint.method === 'POST'
										? 'bg-success/10 text-success'
										: endpoint.method === 'PUT'
											? 'bg-warning/10 text-warning'
											: 'bg-error/10 text-error'
							}`}
						>
							{endpoint.method}
						</em>
						<code class="truncate text-xs font-medium">{endpoint.path}</code>
					</div>
					<div class="h-1.5 overflow-hidden rounded-full bg-base-content/10">
						<div
							class="h-full rounded-full bg-primary"
							style={`width: ${(endpoint.requests / maximumRequests) * 100}%`}
						></div>
					</div>
				</div>
				<output class="text-right text-xs font-semibold text-base-content/70 tabular-nums"
					>{endpoint.requests.toLocaleString()}</output
				>
			</div>
		{/each}
	</div>
</section>
