<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import GgConsole from '$lib/GgConsole.svelte';
	import '../app.css';

	let { children }: { children: Snippet } = $props();

	// Demo pages auto-open the GgConsole panel; other pages just show the icon
	const demoRoutes = ['/', '/demo'];
	let isDemo = $derived(demoRoutes.some((r) => page.url.pathname === r));
</script>

<GgConsole open={isDemo} />
<main>
	{@render children()}
</main>
