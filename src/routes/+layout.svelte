<script lang="ts">
	import '@picocss/pico';

	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { gg, fg, bg } from '$lib/index.js';
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
		gg('Test log from button click!', { timestamp: Date.now() }, ['item1', 'item2', 'item3'], {
			nested: { data: { value: 42 } }
		});
	}

	function testVerbose() {
		// This would use a different namespace in practice
		gg('Verbose log entry', { detail: 'lots of detail here' });
	}

	function testApi() {
		gg('API call started', { endpoint: '/api/users' });
	}

	function testAnsiColors() {
		// Test raw ANSI codes
		gg('\x1b[41mRaw ANSI red\x1b[0m normal text');

		// Test new fg/bg helpers - simple usage
		gg(bg('yellow')`Yellow background`);
		gg(fg('cyan')`Cyan text`);

		// Test method chaining fg + bg (order doesn't matter)
		gg(fg('white').bg('red')`Critical error!`);
		gg(bg('green').fg('white')`Success message`);

		// Define reusable color schemes with chaining
		const input = fg('blue').bg('yellow');
		const transcript = bg('green').fg('white');
		const error = fg('white').bg('red');

		gg(input`User input message`);
		gg(transcript`AI transcript response`);
		gg(error`Error message!`);

		// Test mixing inline
		gg(fg('red')`Error: ` + bg('yellow')`warning` + ' normal text');

		// Test custom hex colors with chaining
		gg(fg('#ff6347').bg('#98fb98')`Tomato on pale green`);
	}
</script>

<main class="container">
	<div style="margin-bottom: 1rem;">
		<button onclick={testLog}>🧪 Test gg() Log</button>
		<button onclick={testVerbose}>📝 Verbose Log</button>
		<button onclick={testApi}>🌐 API Log</button>
		<button onclick={testAnsiColors}>🎨 ANSI Colors</button>
	</div>

	<OpenInEditorLink {ggResult} />

	<div>{@render children()}</div>
</main>
