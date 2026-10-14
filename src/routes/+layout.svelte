<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/mira-favicon.png';
	import Header from '$lib/components/layout/Header.svelte';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="min-h-screen bg-base-200">
	<Header />
	{@render children()}
</div>
