<script lang="ts">
	type User = {
		id: string;
		name: string;
		email: string;
		role: string | null;
		lastAccountUpdate: string | Date | null;
	};

	let { users = [] }: { users?: User[] } = $props();
</script>

<section
	class="flex h-full min-w-0 flex-col text-base-content"
	aria-labelledby="response-times-title"
>
	<div
		class="flex items-center gap-[clamp(1rem,8%,2.75rem)] border-b border-base-content/10 pb-4 max-[240px]:gap-2"
	>
		<table class="table">
			<thead>
				<tr>
					<th>User</th>
					<th>Last Activity</th>
				</tr>
			</thead>
			<tbody>
				{#each users as user (user.id)}
					<tr>
						<td>
							<div class="flex items-center gap-3">
								<div>
									<div class="font-bold">
										{user.name}
										{#if user.role === 'admin'}<span class="badge badge-sm badge-primary"
												>admin</span
											>{/if}
									</div>
									<div class="text-sm opacity-50">{user.email}</div>
								</div>
							</div>
						</td>
						<td>
							{user.lastAccountUpdate
								? new Date(user.lastAccountUpdate).toLocaleDateString()
								: 'Never'}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>
