<script lang="ts">
	import '@picocss/pico';

	import type { Snippet } from 'svelte';
	import { gg } from '$lib/index.js';
	import OpenInEditorLink from '$lib/OpenInEditorLink.svelte';

	let { children }: { children: Snippet } = $props();

	gg('Hello, gg!!');
	gg('The colored *callpoint* indicates the location of this logg. (As filename@function)');

	// gg() without arguments outputs a link that causes
	// vite to open this file in an editor (like VS Code.)
	gg('The link below opens the file containing the callpoint in your editor:');
	const ggResult = gg();
</script>

<main class="container">
	<OpenInEditorLink {ggResult} />

	<div>{@render children()}</div>
</main>
