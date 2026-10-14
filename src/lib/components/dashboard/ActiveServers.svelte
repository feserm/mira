<script lang="ts">
	import { resolve } from '$app/paths';

	type Server = {
		id: number;
		alias: string;
	};

	let { servers = [] }: { servers?: Server[] } = $props();
</script>

<section
	class="@container flex h-full min-w-0 flex-col text-base-content"
	aria-labelledby="response-times-title"
>
	<div
		class="flex items-center gap-[clamp(1rem,8%,2.75rem)] border-b border-base-content/10 pb-4 max-[240px]:gap-2"
	>
		<table class="table">
			<thead>
				<tr>
					<th>Handle</th>
					<th>BrAPI Server</th>
					<th>ARC Overview</th>
				</tr>
			</thead>
			<tbody>
				{#each servers as server (server.id)}
					<tr>
						<td>{server.alias}</td>
						<td>
							<a class="link italic" href={resolve(`/${server.alias}/brapi/v2/serverinfo`)}>
								Go to Serverinfo
							</a>
						</td>
						<td>
							<a class="link italic" href={resolve(`/arcs/${server.id}`)}>Go to ARC</a>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>
