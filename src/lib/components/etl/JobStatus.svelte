<script lang="ts">
	import type { JobView } from '$lib/types/etl';

	let { job }: { job: JobView | null } = $props();

	const stepLabel = { extract: 'Extract', transform: 'Transform', load: 'Load' } as const;

	function formatDateTime(value: string) {
		return new Date(value).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

{#if job}
	<div
		class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
		role="status"
		aria-live="polite"
	>
		{#if job.state === 'queued'}
			<span class="loading loading-sm loading-spinner text-base-content/60"></span>
			<span class="font-medium">
				{job.attempts > 0 ? 'Waiting to retry' : 'Import queued'}
			</span>
			{#if job.attempts > 0 && job.error}
				<span class="text-xs text-warning">
					Attempt {job.attempts} of {job.maxAttempts} failed: {job.error}
				</span>
			{/if}
		{:else if job.state === 'running'}
			<span class="loading loading-sm loading-spinner text-primary"></span>
			<span class="font-medium">
				Importing{job.currentStep ? `: ${stepLabel[job.currentStep]}` : ''}
			</span>
			{#if job.attempts > 1}
				<span class="text-xs text-base-content/50">attempt {job.attempts} of {job.maxAttempts}</span
				>
			{/if}
		{:else if job.state === 'succeeded'}
			<span class="badge badge-sm badge-success">Import finished</span>
			{#if job.finishedAt}
				<span class="text-xs text-base-content/50">{formatDateTime(job.finishedAt)}</span>
			{/if}
		{:else}
			<span class="badge badge-sm badge-error">Import failed</span>
			{#if job.finishedAt}
				<span class="text-xs text-base-content/50">{formatDateTime(job.finishedAt)}</span>
			{/if}
			{#if job.error}
				<p class="w-full text-xs text-error">{job.error}</p>
			{/if}
		{/if}
	</div>
{/if}
