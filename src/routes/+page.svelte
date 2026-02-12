<script lang="ts">
	import { gg } from '$lib/index.js';
	import OpenInEditorLink from '$lib/OpenInEditorLink.svelte';
	import { testManualNs, testAnsiColors } from './demo-helpers.js';

	// Early log buffer in gg.ts handles buffering before Eruda loads
	gg('Hello, gg!!');
	gg('The colored *callpoint* indicates the location of this logg. (As filename@function)');
	gg(
		"Hello, again! This logg's color differs because the callpoint's file and/or function differ."
	);

	function testLog() {
		const data = { count: 42, active: true };
		gg(data);
		gg('Test log from button click!', { timestamp: Date.now() }, ['item1', 'item2', 'item3'], {
			nested: { data: { value: 42 } }
		});
		gg(data.count + 99);
	}
</script>

<h1>gg() demo/test site</h1>

<p>Open the browser dev console or Eruda's GG tab to check the output of gg().</p>

<div style="margin-bottom: 1rem;">
	<button onclick={testLog}>🧪 Test gg() Log</button>
	<button onclick={testManualNs}>🏷️ gg.ns() Templates</button>
	<button onclick={testAnsiColors}>🎨 ANSI Colors</button>
	<button onclick={() => gg.ns('$NS:click', 'template event handler')}>🔬 Template gg()</button>
</div>

<OpenInEditorLink gg={gg()} />

<p><small>Template expression: {gg('inline template gg()')}</small></p>
