<script lang="ts">
	import { enhance } from '$app/forms';
	import IconCircleCheck from '@tabler/icons-svelte-runes/icons/circle-check';
	import IconCircleDashed from '@tabler/icons-svelte-runes/icons/circle-dashed';
	import IconCircleX from '@tabler/icons-svelte-runes/icons/circle-x';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';

	type StepStatus = 'pending' | 'success' | 'failed';

	interface StagingRow {
		extractStatus: StepStatus;
		extractedAt: Date | string | null;
		extractError: string | null;
		transformStatus: StepStatus;
		transformedAt: Date | string | null;
		transformError: string | null;
		loadStatus: StepStatus;
		loadedAt: Date | string | null;
		loadError: string | null;
	}

	/** `busy`: an import job is queued or running, so the buttons are disabled. */
	let { staging, busy = false }: { staging: StagingRow | null; busy?: boolean } = $props();

	type StepKey = 'extract' | 'transform' | 'load';

	let submitting: Record<StepKey, boolean> = $state({
		extract: false,
		transform: false,
		load: false
	});

	function formatDateTime(value: Date | string) {
		return new Date(value).toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	const steps = $derived([
		{
			key: 'extract' as StepKey,
			label: 'Extract',
			status: staging?.extractStatus ?? ('pending' as StepStatus),
			at: staging?.extractedAt ?? null,
			error: staging?.extractError ?? null,
			enabled: true
		},
		{
			key: 'transform' as StepKey,
			label: 'Transform',
			status: staging?.transformStatus ?? ('pending' as StepStatus),
			at: staging?.transformedAt ?? null,
			error: staging?.transformError ?? null,
			enabled: staging?.extractStatus === 'success'
		},
		{
			key: 'load' as StepKey,
			label: 'Load',
			status: staging?.loadStatus ?? ('pending' as StepStatus),
			at: staging?.loadedAt ?? null,
			error: staging?.loadError ?? null,
			enabled: staging?.transformStatus === 'success'
		}
	]);
</script>

<div class="rounded-box border border-base-300 bg-base-200/40 p-4">
	<ul class="flex flex-col">
		{#each steps as step, i (step.key)}
			<li class="relative flex gap-3 pb-4 last:pb-0">
				{#if i < steps.length - 1}
					<span class="absolute top-6 left-[11px] h-full w-px bg-base-300"></span>
				{/if}
				<div class="z-10 shrink-0">
					{#if submitting[step.key]}
						<span class="loading loading-sm loading-spinner text-base-content/60"></span>
					{:else if step.status === 'success'}
						<IconCircleCheck size={22} class="text-success" />
					{:else if step.status === 'failed'}
						<IconCircleX size={22} class="text-error" />
					{:else}
						<IconCircleDashed size={22} class="text-base-content/40" />
					{/if}
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div class="flex items-center gap-2">
							<span class="font-medium">{step.label}</span>
							{#if step.at}
								<span class="text-xs text-base-content/50">{formatDateTime(step.at)}</span>
							{/if}
						</div>
						<form
							method="POST"
							action="?/{step.key}"
							use:enhance={() => {
								submitting[step.key] = true;
								return async ({ update }) => {
									await update();
									submitting[step.key] = false;
								};
							}}
						>
							<button
								type="submit"
								class="btn btn-ghost btn-xs"
								disabled={!step.enabled || submitting[step.key] || busy}
								aria-label={i === 0 && step.status === 'pending'
									? 'Import RO-Crate'
									: `Re-run ${step.label}`}
							>
								<IconRefresh size={14} />
								{i === 0 && step.status === 'pending' ? 'Import RO-Crate' : 'Re-run'}
							</button>
						</form>
					</div>
					{#if step.error}
						<p class="mt-1 text-xs text-error">{step.error}</p>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
</div>
