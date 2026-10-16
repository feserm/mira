<script lang="ts">
	import Grid from 'svelte-grid';
	import gridHelp from 'svelte-grid/src/utils/helper.js';
	import { browser } from '$app/environment';
	import type { PageProps } from './$types';
	import UserStats from '$lib/components/dashboard/UserStats.svelte';
	import type { DashboardLayoutItem } from '$lib/server/db/schema';
	import {
		IconPlus,
		IconPencil,
		IconDeviceFloppy,
		IconSettings,
		IconX
	} from '@tabler/icons-svelte-runes';
	import ResponseTimes from '$lib/components/dashboard/ResponseTimes.svelte';
	import ActiveServers from '$lib/components/dashboard/ActiveServers.svelte';
	import EndpointPopularity from '$lib/components/dashboard/EndpointPopularity.svelte';
	import RequestChart from '$lib/components/dashboard/RequestChart.svelte';
	import ServerStats from '$lib/components/dashboard/ServerStats.svelte';

	let { data }: PageProps = $props();

	type GridItem = DashboardLayoutItem & {
		4: {
			x: number;
			y: number;
			w: number;
			h: number;
			min: { w: number; h: number };
			resizable: boolean;
			draggable: boolean;
			customDragger: boolean;
		};
	};

	const cols = 4;
	const breakpoints: [number, number][] = [[0, cols]];
	let items = $state.raw<GridItem[]>([]);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let hasHydrated = false;

	const mappings = {
		RequestChart: RequestChart,
		UserStats: UserStats,
		ResponseTimes: ResponseTimes,
		ActiveServers: ActiveServers,
		EndpointPopularity: EndpointPopularity,
		ServerStats: ServerStats
	};
	type ComponentType = keyof typeof mappings;

	function beautifyComponentType(type: string) {
		return type.replace(/([a-z])([A-Z])/g, '$1 $2');
	}

	function toGridItems(layout: DashboardLayoutItem[]) {
		return layout.map((item) => ({
			...item,
			[cols]: gridHelp.item({
				...item,
				min: { w: 1, h: 2 },
				customDragger: true
			})
		})) as GridItem[];
	}

	function cleanLayout() {
		return items.map(({ id, type, [cols]: position }) => ({
			id,
			type,
			x: position.x,
			y: position.y,
			w: position.w,
			h: position.h
		}));
	}

	async function saveLayout(layout = cleanLayout()) {
		clearTimeout(saveTimer);
		const formData = new FormData();
		formData.append('layout', JSON.stringify(layout));

		try {
			const response = await fetch('?/saveLayout', { method: 'POST', body: formData });
			if (!response.ok) throw new Error('Unable to save layout');
		} catch {
			// autosave is best-effort; the next layout change retries
		}
		return;
	}

	function addComponent(type: ComponentType) {
		const item = {
			id: `${type}-${crypto.randomUUID()}`,
			type,
			x: 0,
			y: 0,
			w: 2,
			h: 2,
			min: { w: 1, h: 2 },
			customDragger: true
		};
		const gridItem = {
			...item,
			[cols]: gridHelp.item(item)
		} as GridItem;
		const position = gridHelp.findSpace(gridItem, items, cols);

		items = [
			...items,
			{
				...gridItem,
				[cols]: { ...gridItem[cols], ...position }
			}
		];
	}

	function removeComponent(id: string) {
		items = items.filter((item) => item.id !== id);
	}

	$effect(() => {
		if (!hasHydrated) {
			items = toGridItems(data.layout);
			hasHydrated = true;
			return;
		}
		const layout = cleanLayout();
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveLayout(layout), 1000);
	});
</script>

<svelte:head><title>Dashboard · Mira</title></svelte:head>

{#if !data.authenticated}
	<div class="mx-auto max-w-2xl px-4 py-20 text-center sm:px-6">
		<p class="text-sm font-medium tracking-wide text-primary uppercase">Workspace overview</p>
		<h1 class="mt-3 text-3xl font-bold tracking-tight">Your dashboard awaits</h1>
		<p class="mt-3 text-base-content/60">Log in to arrange and save your workspace widgets.</p>
	</div>
{:else}
	{@const analytics = data.analytics}
	<div class="mx-auto max-w-full">
		{#if browser}
			<Grid
				bind:items
				cols={breakpoints}
				rowHeight={112}
				gap={[8, 8]}
				let:dataItem
				let:movePointerDown
			>
				<div
					class="card relative h-full w-full overflow-hidden border border-base-300 bg-base-100 shadow-sm"
				>
					<header
						class="flex cursor-move items-center justify-between border-b border-base-300 bg-base-200/75 px-4 py-2"
						role="toolbar"
						aria-label={`${dataItem.type} widget controls`}
						tabindex="0"
						onpointerdown={movePointerDown}
					>
						<span class="text-sm font-semibold">{beautifyComponentType(dataItem.type)}</span>
						<button
							class="btn btn-circle btn-outline text-error btn-error btn-xs hover:bg-error/25"
							aria-label={`Remove ${dataItem.type}`}
							title={`Remove ${dataItem.type}`}
							onpointerdown={(event) => event.stopPropagation()}
							onmousedown={(event) => event.stopPropagation()}
							onclick={() => removeComponent(dataItem.id)}
						>
							<IconX size={14} />
						</button>
					</header>
					<div class="card-body h-full p-5">
						{#if dataItem.type}
							{#if dataItem.type === 'EndpointPopularity'}
								<EndpointPopularity endpoints={analytics?.endpointPopularity ?? []} />
							{:else if dataItem.type === 'RequestChart'}
								<RequestChart dailyRequests={analytics?.dailyRequests ?? []} />
							{:else if dataItem.type === 'ResponseTimes'}
								<ResponseTimes
									endpoints={analytics?.responseTimes ?? []}
									medianResponseTimeMs={analytics?.medianResponseTimeMs ?? 0}
								/>
							{:else if dataItem.type === 'UserStats'}
								<UserStats users={data.users ?? []} />
							{:else if dataItem.type === 'ActiveServers'}
								<ActiveServers servers={data.servers ?? []} />
							{:else if dataItem.type === 'ServerStats'}
								<ServerStats
									counts={data.brapiTableCounts ?? []}
									servers={data.servers ?? []}
									selectedServerId={data.selectedServerId}
								/>
							{/if}
						{/if}
					</div>
				</div>
			</Grid>
		{/if}
	</div>

	<div class="fab fab-flower">
		<div tabindex="0" role="button" aria-label="Settings" class="btn btn-circle btn-lg">
			<IconSettings size={24} />
		</div>

		<button class="btn fab-main-action btn-circle btn-lg btn-primary" aria-label="Edit dashboard">
			<IconPencil size={24} />
		</button>

		<button class="btn btn-circle btn-lg" aria-label="Save layout" onclick={() => saveLayout()}>
			<IconDeviceFloppy size={24} />
		</button>

		<div class="dropdown dropdown-end dropdown-top">
			<button tabindex="0" class="btn btn-circle btn-lg" aria-label="Add component">
				<IconPlus size={24} />
			</button>
			<ul class="menu dropdown-content z-1 mb-3 w-56 rounded-box bg-base-100 p-2 shadow-lg">
				<li class="menu-title">Add component</li>
				{#each Object.keys(mappings) as type (type)}
					<li>
						<button onclick={() => addComponent(type as ComponentType)}
							>{beautifyComponentType(type)}</button
						>
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}
