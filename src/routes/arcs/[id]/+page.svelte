<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import { visibilityBadgeClass } from '$lib/utils/gitlab';
	import PipelineSteps from '$lib/components/etl/PipelineSteps.svelte';
	import JobStatus from '$lib/components/etl/JobStatus.svelte';
	import type { JobView } from '$lib/types/etl';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let dismissedAlertKey: string | undefined = $state(undefined);
	let alertKey = $derived(form ? `${form.success ?? false}:${form.message ?? ''}` : undefined);
	let showAlert = $derived(!!alertKey && alertKey !== dismissedAlertKey);

	// The import runs in a background worker. Polling happens only while a job is queued or running;
	// when it ends, reload the page data once so the step statuses are current.
	const POLL_MS = 2000;
	const isActive = (j: JobView | null) => j?.state === 'queued' || j?.state === 'running';
	let job = $derived(data.job);
	let active = $derived(isActive(job));

	$effect(() => {
		if (!active) return;
		const timer = setInterval(async () => {
			try {
				const res = await fetch(resolve('/arcs/[id]/job', { id: String(data.arc.id) }));
				if (!res.ok) return;
				const body: { job: JobView | null } = await res.json();
				job = body.job;
				if (!isActive(body.job)) await invalidateAll();
			} catch {
				// A failed poll (e.g. a pod restart) is retried on the next tick.
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	function dismissAlert() {
		dismissedAlertKey = alertKey;
	}

	function formatDate(iso: string) {
		return new Date(iso).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function formatSize(bytes: number) {
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let value = bytes / 1024;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit++;
		}
		return `${value.toFixed(1)} ${units[unit]}`;
	}
</script>

<svelte:head><title>{data.arc.name} · ARCs · Mira</title></svelte:head>

{#if showAlert}
	<div
		role="alert"
		class="alert {form?.success
			? 'alert-success'
			: 'alert-error'} fixed top-20 right-4 z-50 w-auto max-w-xs px-3 py-2 text-sm shadow-lg sm:right-6"
	>
		<span>{form?.message}</span>
		<button
			type="button"
			class="btn btn-circle btn-ghost btn-xs"
			aria-label="Dismiss"
			onclick={dismissAlert}
		>
			<IconX size={14} />
		</button>
	</div>
{/if}

<div class="mx-auto max-w-4xl px-4 py-8 sm:px-6">
	<a href={resolve('/arcs')} class="mb-6 inline-block link text-sm text-base-content/60 link-hover">
		&laquo; Back to ARCs
	</a>

	<div class="card bg-base-100 shadow-sm">
		<div class="card-body">
			<div class="flex items-start gap-4">
				{#if data.arc.avatar_url}
					<div class="avatar">
						<div class="w-14 rounded">
							<img src={data.arc.avatar_url} alt="" />
						</div>
					</div>
				{/if}
				<div class="min-w-0">
					<h1 class="text-2xl font-bold wrap-break-word">{data.arc.name}</h1>
					<p class="text-sm text-base-content/60">{data.arc.namespace.full_path}</p>
				</div>
			</div>

			{#if data.arc.description}
				<p class="mt-4 text-base-content/80">{data.arc.description}</p>
			{/if}

			<div class="mt-4 flex flex-wrap gap-2">
				<span class="badge {visibilityBadgeClass(data.arc.visibility)}">{data.arc.visibility}</span>
				{#if data.arc.archived}
					<span class="badge badge-warning">archived</span>
				{/if}
				{#each data.arc.topics as topic (topic)}
					<span class="badge badge-outline">{topic}</span>
				{/each}
			</div>

			<div class="divider"></div>

			<div class="flex flex-wrap items-start justify-between gap-4">
				<div class="min-w-0">
					<h2 class="font-medium">RO-Crate pipeline</h2>
					<p class="mt-1 text-xs text-base-content/50">
						Loads this ARC's ISA RO-Crate metadata into Mira for further processing.
					</p>
				</div>
				{#if data.staging?.extractStatus === 'success'}
					<a
						href={resolve('/arcs/[id]/ro-crate', { id: String(data.arc.id) })}
						download
						class="btn shrink-0 btn-ghost btn-sm"
					>
						Download staged RO-Crate
					</a>
				{/if}
			</div>

			<JobStatus {job} />
			<PipelineSteps staging={data.staging} busy={active} />

			{#if data.brapiRepo}
				<a
					href={resolve('/[repo]/brapi/v2/serverinfo', { repo: data.brapiRepo.toLowerCase() })}
					target="_blank"
					class="mt-1 link text-xs link-hover"
				>
					GET /brapi/v2/serverinfo
				</a>
			{/if}

			<div class="divider"></div>

			<div class="stats w-full stats-vertical border border-base-300 sm:stats-horizontal">
				<div class="stat">
					<div class="stat-title">Created</div>
					<div class="stat-value text-base">{formatDate(data.arc.created_at)}</div>
				</div>
				<div class="stat">
					<div class="stat-title">Last activity</div>
					<div class="stat-value text-base">{formatDate(data.arc.last_activity_at)}</div>
				</div>
				<div class="stat">
					<div class="stat-title">License</div>
					<div class="stat-value text-base">{data.arc.license?.key ?? '—'}</div>
				</div>
			</div>

			<div class="stats mt-2 w-full stats-vertical border border-base-300 sm:stats-horizontal">
				<div class="stat">
					<div class="stat-title">Stars</div>
					<div class="stat-value text-base">{data.arc.star_count}</div>
				</div>
				<div class="stat">
					<div class="stat-title">Forks</div>
					<div class="stat-value text-base">{data.arc.forks_count}</div>
				</div>
				<div class="stat">
					<div class="stat-title">Open issues</div>
					<div class="stat-value text-base">{data.arc.open_issues_count ?? '—'}</div>
				</div>
				{#if data.arc.statistics}
					<div class="stat">
						<div class="stat-title">Repository size</div>
						<div class="stat-value text-base">
							{formatSize(data.arc.statistics.repository_size)}
						</div>
					</div>
					<div class="stat">
						<div class="stat-title">Storage size</div>
						<div class="stat-value text-base">{formatSize(data.arc.statistics.storage_size)}</div>
					</div>
				{/if}
			</div>

			<div class="mt-6 card-actions items-center justify-end">
				<a
					href={data.arc.web_url}
					target="_blank"
					rel="external noopener noreferrer"
					class="link text-sm link-hover"
				>
					View on PLANTdataHUB &rarr;
				</a>
			</div>
		</div>
	</div>
</div>
