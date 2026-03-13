<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import GgConsole from '$lib/GgConsole.svelte';

	let { children }: { children: Snippet } = $props();

	// Demo pages auto-open the GgConsole panel; other pages just show the icon
	const demoRoutes = ['/', '/demo'];
	let isDemo = $derived(demoRoutes.some((r) => page.url.pathname === r));
</script>

<GgConsole open={isDemo} />
<main class="container">
	{@render children()}
</main>

<style>
	:global(body) {
		margin: 0;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
		line-height: 1.5;
		color: #1a1a1a;
	}

	.container {
		max-width: 960px;
		margin: 0 auto;
		padding: 1rem 1.5rem;
	}
</style>
