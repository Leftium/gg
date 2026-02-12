<script lang="ts">
	import '@picocss/pico';

	import type { Snippet } from 'svelte';
	import GgConsole from '$lib/GgConsole.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<GgConsole />
<main class="container">
	{@render children()}
</main>
