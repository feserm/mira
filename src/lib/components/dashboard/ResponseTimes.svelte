<script lang="ts">
	type ResponseTime = { name: string; method: string; value: number };

	let {
		endpoints = [],
		medianResponseTimeMs = 0
	}: { endpoints?: ResponseTime[]; medianResponseTimeMs?: number } = $props();

	const target = 250;
	const maximum = 400;
</script>

<section
	class="flex h-full min-w-0 flex-col text-base-content"
	aria-labelledby="response-times-title"
>
	<div
		class="flex items-center gap-[clamp(1rem,8%,2.75rem)] border-b border-base-content/10 pb-4 max-[240px]:gap-2"
	>
		<div class="min-w-0">
			<span class="mb-1 block text-xs text-base-content/60 max-[240px]:whitespace-normal"
				>Median response time</span
			><strong class="text-[clamp(1.5rem,4vw,1.875rem)] leading-none"
				>{medianResponseTimeMs}<small class="text-xs font-medium text-base-content/60">
					ms</small
				></strong
			>
		</div>
		<div class="min-w-0">
			<span class="mb-1 block text-xs text-base-content/60 max-[240px]:whitespace-normal"
				>Target</span
			><strong
				class="text-[clamp(1.5rem,4vw,1.875rem)] leading-none text-base-content/60 max-[240px]:text-xl"
				>{target}<small class="text-xs font-medium"> ms</small></strong
			>
		</div>
	</div>

	<div
		class="relative flex min-h-0 flex-1 flex-col pt-5"
		aria-label={`Median response time ${medianResponseTimeMs} milliseconds; target ${target} milliseconds`}
	>
		<div
			class="pointer-events-none absolute inset-y-3 z-[2] border-l-2 border-dashed border-error"
			style={`left: ${(target / maximum) * 100}%`}
		>
			<b
				class="absolute -top-3 left-1 bg-base-100 px-1 text-[10px] font-semibold whitespace-nowrap text-error"
				>Target</b
			>
		</div>
		<div class="min-h-0 flex-1 space-y-3 overflow-y-auto">
			{#each endpoints as endpoint (`${endpoint.method}-${endpoint.name}`)}
				<div class="min-w-0">
					<div class="mb-1 flex min-w-0 items-center justify-between gap-2">
						<div class="flex min-w-0 items-center gap-1.5">
							<em
								class={`inline-block w-fit shrink-0 rounded px-1 py-0.5 text-[9px] font-bold not-italic max-[240px]:text-[8px] ${
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
							<code
								class="truncate text-xs font-medium max-[240px]:text-[10px]"
								title={endpoint.name}>{endpoint.name}</code
							>
						</div>
						<output
							class="shrink-0 text-right text-[11px] text-base-content/70 max-[240px]:text-[9px]"
							>{endpoint.value} ms</output
						>
					</div>
					<div class="h-2 min-w-0 overflow-hidden rounded bg-base-content/10">
						<div
							class={`h-full rounded ${
								endpoint.value / target <= 0.4
									? 'bg-success'
									: endpoint.value / target <= 0.55
										? 'bg-info'
										: endpoint.value / target <= 0.75
											? 'bg-warning'
											: 'bg-error'
							}`}
							style={`width: ${(endpoint.value / maximum) * 100}%`}
						></div>
					</div>
				</div>
			{/each}
		</div>
		<div class="flex justify-between pt-2 text-[10px] text-base-content/45 max-[240px]:text-[8px]">
			<span>0 ms</span><span>200 ms</span><span>400 ms</span>
		</div>
	</div>
</section>
