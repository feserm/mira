<script lang="ts">
	type DailyRequests = {
		date: string;
		requests: number;
	};

	let { dailyRequests }: { dailyRequests: DailyRequests[] } = $props();
	let hoveredDate = $state<string | null>(null);

	const totalRequests = $derived(dailyRequests.reduce((total, day) => total + day.requests, 0));
	const chart = { left: 42, right: 690, top: 18, bottom: 174, height: 156 };
	const maximumRequests = $derived(Math.max(...dailyRequests.map((day) => day.requests), 0));
	const tickStep = $derived.by(() => {
		const target = Math.max(maximumRequests / 4, 1);
		const magnitude = 10 ** Math.floor(Math.log10(target));
		const normalized = target / magnitude;
		const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
		return niceNormalized * magnitude;
	});
	const maximum = $derived(tickStep * 4);

	const points = $derived(
		dailyRequests.map((day, index) => {
			const x =
				chart.left + (index / Math.max(dailyRequests.length - 1, 1)) * (chart.right - chart.left);
			const y = chart.bottom - (day.requests / maximum) * chart.height;
			return { ...day, x, y };
		})
	);

	const linePoints = $derived(points.map((point) => `${point.x},${point.y}`).join(' '));
	const areaPoints = $derived(
		`${chart.left},${chart.bottom} ${linePoints} ${chart.right},${chart.bottom}`
	);
	const yTicks = $derived(Array.from({ length: 5 }, (_, index) => index * tickStep));
	const activePoint = $derived(points.find((point) => point.date === hoveredDate));
	const dateFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
	const numberFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
</script>

<section
	class="flex h-full min-w-0 flex-col text-base-content"
	aria-labelledby="request-chart-title"
>
	<div class="mb-3 flex items-end gap-2 border-b border-base-content/10 pb-4">
		<strong class="text-3xl leading-none">{totalRequests.toLocaleString()}</strong>
		<span class="pb-0.5 text-xs text-base-content/60">requests in the last 30 days</span>
	</div>

	<div class="min-h-0 flex-1" aria-label="Daily BrAPI request totals for the last 30 days">
		<svg
			class="h-full min-h-40 w-full overflow-visible"
			viewBox="0 0 720 220"
			preserveAspectRatio="none"
			role="img"
			aria-labelledby="request-chart-title"
		>
			<title>Daily request totals</title>
			{#each yTicks as tick (tick)}
				{@const y = chart.bottom - (tick / maximum) * chart.height}
				<line
					x1={chart.left}
					x2={chart.right}
					y1={y}
					y2={y}
					class="stroke-base-content/10"
					stroke-width="1"
				/>
				<text x="0" y={y + 4} class="fill-base-content/45 text-[11px]">{tick.toLocaleString()}</text
				>
			{/each}

			<polygon points={areaPoints} class="fill-primary/10" />
			<polyline
				points={linePoints}
				fill="none"
				class="stroke-primary"
				stroke-width="3"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>

			{#each points as point (point.date)}
				<circle
					cx={point.x}
					cy={point.y}
					r={hoveredDate === point.date ? 6 : 4}
					class="fill-base-100 stroke-primary"
					stroke-width="3"
					role="button"
					tabindex="0"
					aria-label={`${point.date}: ${point.requests.toLocaleString()} requests`}
					onmouseenter={() => (hoveredDate = point.date)}
					onmouseleave={() => (hoveredDate = null)}
					onfocus={() => (hoveredDate = point.date)}
					onblur={() => (hoveredDate = null)}
				>
					<title>{point.date}: {point.requests.toLocaleString()} requests</title>
				</circle>
				{#if point.date.slice(8, 10) === '01' || Number(point.date.slice(8, 10)) % 5 === 0 || point === points.at(-1)}
					<text x={point.x} y="204" text-anchor="middle" class="fill-base-content/55 text-[11px]">
						{dateFormatter.format(new Date(point.date))}
					</text>
				{/if}
			{/each}

			{#if activePoint}
				{@const tooltipWidth = 144}
				{@const tooltipX = Math.min(
					Math.max(activePoint.x - tooltipWidth / 2, chart.left),
					chart.right - tooltipWidth
				)}
				{@const tooltipY = activePoint.y > 52 ? activePoint.y - 46 : activePoint.y + 12}
				<g class="pointer-events-none">
					<rect
						x={tooltipX}
						y={tooltipY}
						width={tooltipWidth}
						height="34"
						rx="4"
						class="fill-base-100 stroke-base-content/20"
					/>
					<text
						x={tooltipX + tooltipWidth / 2}
						y={tooltipY + 14}
						text-anchor="middle"
						class="fill-base-content text-[11px]"
					>
						{dateFormatter.format(new Date(activePoint.date))}
					</text>
					<text
						x={tooltipX + tooltipWidth / 2}
						y={tooltipY + 27}
						text-anchor="middle"
						class="fill-base-content text-[11px] font-semibold"
					>
						{numberFormatter.format(activePoint.requests)} requests
					</text>
				</g>
			{/if}
		</svg>
	</div>
</section>
