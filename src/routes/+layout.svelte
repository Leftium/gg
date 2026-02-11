<script lang="ts">
	import '@picocss/pico';

	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { gg, fg, bg } from '$lib/index.js';
	import { initGgEruda } from '$lib/eruda/index.js';
	import OpenInEditorLink from '$lib/OpenInEditorLink.svelte';

	let { children }: { children: Snippet } = $props();

	// gg() with no arguments returns call-site info for open-in-editor
	const ggResult = gg();

	// Initialize Eruda plugin first
	initGgEruda();

	// Wait for Eruda to load before logging
	onMount(() => {
		// Give Eruda a moment to initialize
		setTimeout(() => {
			gg('Hello, gg!!');
			gg('The colored *callpoint* indicates the location of this logg. (As filename@function)');
		}, 100);
	});

	function testLog() {
		const data = { count: 42, active: true };
		gg(data);
		gg('Test log from button click!', { timestamp: Date.now() }, ['item1', 'item2', 'item3'], {
			nested: { data: { value: 42 } }
		});
	}

	function testManualNs() {
		// Plain label (no template variables) - used as-is
		gg.ns('CUSTOM_NAMESPACE', 'Plain custom namespace - no @functionName appended');

		// Template variables demo
		gg.ns('ERROR:$NS', 'Error with auto-generated callpoint suffix');
		gg.ns('$FILE:validation', 'File path with custom tag');
		gg.ns('TRACE:$FN', 'Custom prefix with just function name');
		gg.ns('$NS:debug', 'Full callpoint with custom suffix');

		// Multiple calls with same custom namespace (grouped by color)
		gg.ns('CUSTOM_NAMESPACE', 'Message 1');
		gg.ns('CUSTOM_NAMESPACE', 'Message 2', { data: Date.now() });
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
		<button onclick={testManualNs}>🏷️ gg.ns() Templates</button>
		<button onclick={testAnsiColors}>🎨 ANSI Colors</button>
		<button onclick={() => gg.ns('$NS:click', 'template event handler')}>🔬 Template gg()</button>
	</div>

	<OpenInEditorLink
		url={ggResult.url}
		fileName={ggResult.fileName}
		title={`${ggResult.fileName}@${ggResult.functionName}`}
	/>

	<p><small>Template expression: {gg('inline template gg()')}</small></p>

	<div>{@render children()}</div>
</main>
