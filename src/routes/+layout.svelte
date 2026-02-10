<script lang="ts">
	import '@picocss/pico';

	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { gg } from '$lib/index.js';
	import { initGgEruda } from '$lib/eruda/index.js';
	import OpenInEditorLink from '$lib/OpenInEditorLink.svelte';
	import type ErrorStackParser from 'error-stack-parser';

	let { children }: { children: Snippet } = $props();
	let ggResult = $state<{
		fileName: string;
		functionName: string;
		url: string;
		stack: ErrorStackParser.StackFrame[];
	}>({ fileName: '', functionName: '', url: '', stack: [] });

	// Initialize Eruda plugin first
	initGgEruda();

	// Wait for Eruda to load before logging
	onMount(() => {
		// Give Eruda a moment to initialize
		setTimeout(() => {
			gg('Hello, gg!!');
			gg('The colored *callpoint* indicates the location of this logg. (As filename@function)');
			gg('The link below opens the file containing the callpoint in your editor:');
			ggResult = gg();
		}, 100);
	});

	function testLog() {
		gg('Test log from button click!', { timestamp: Date.now() });
	}
</script>

<main class="container">
	<div style="margin-bottom: 1rem;">
		<button onclick={testLog}>🧪 Test gg() Log</button>
	</div>

	<OpenInEditorLink {ggResult} />

	<div>{@render children()}</div>
</main>
