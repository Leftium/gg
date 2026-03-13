<script lang="ts">
	import { gg } from '$lib/index.js';
	import OpenInEditorLink from '$lib/OpenInEditorLink.svelte';
	import {
		testManualNs,
		testAnsiColors,
		testTextStyling,
		testInfo,
		testWarnError,
		testTable,
		testTimers,
		testTrace,
		testNamespaceSegments,
		testExpressions,
		stressTest
	} from './demo-helpers.js';

	// Early log buffer in gg.ts handles buffering before Eruda loads
	gg('Hello, gg!!');
	gg('The colored *callpoint* indicates the location of this logg. (As filename@function)');
	gg(
		"Hello, again! This logg's color differs because the callpoint's file and/or function differ."
	);

	// SSR hydration demo — these run on both server and client, values differ
	// Shows how gg() helps diagnose hydration mismatches via env:"server" vs env:"client"
	gg('typeof window:', typeof window);
	gg('import.meta.env.SSR:', import.meta.env.SSR);
	gg('Date.now():', Date.now());
	gg('Math.random():', Math.random());

	let stopStress: (() => void) | null = $state(null);

	function testLog() {
		const data = { count: 42, active: true };
		gg(data);
		gg('Test log from button click!', { timestamp: Date.now() }, ['item1', 'item2', 'item3'], {
			nested: { data: { value: 42 } }
		});
		gg(data.count + 99);
	}

	function handleStress() {
		if (stopStress) {
			stopStress();
			stopStress = null;
		} else {
			stopStress = stressTest(() => {
				stopStress = null;
			});
		}
	}
</script>

<h1>gg() demo/test site</h1>

<p>Check the Eruda GG tab below or the browser dev console to see the output of gg().</p>

<div style="margin-bottom: 1rem;">
	<button onclick={testLog}>🧪 Test gg() Log</button>
	<button onclick={testManualNs}>🏷️ .ns() Templates</button>
	<button onclick={testAnsiColors}>🎨 ANSI Colors</button>
	<button onclick={testTextStyling}>✨ Text Styling (bold/italic)</button>
	<button onclick={() => gg('template event handler').ns('$NS:click')}>🔬 Template gg()</button>
	<button onclick={testNamespaceSegments}>🔗 Namespace Segments</button>
	<button onclick={testExpressions}>🔍 Test Expressions</button>
</div>

<h3>Console-like Methods</h3>
<div style="margin-bottom: 1rem;">
	<button onclick={testInfo}>ℹ️ info</button>
	<button onclick={testWarnError}>⚠️ warn / error</button>
	<button onclick={testTable}>📊 table</button>
	<button onclick={testTimers}>⏱️ time / timeEnd</button>
	<button onclick={testTrace}>🔍 trace</button>
</div>

<h3>Performance</h3>
<div style="margin-bottom: 1rem;">
	<button onclick={handleStress}
		>{stopStress ? '⏹️ Stop Stress Test' : '🔥 Stress Test (3K msgs)'}</button
	>
</div>

<OpenInEditorLink gg={gg.here()} />

<p><small>Template expression: {gg('inline template gg()').v}</small></p>

<style>
	h1 {
		margin: 0.5rem 0;
	}

	h3 {
		margin: 1.25rem 0 0.5rem;
	}

	div {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	button {
		padding: 0.5rem 1rem;
		border: none;
		border-radius: 6px;
		background: #2563eb;
		color: #fff;
		font-size: 0.9rem;
		cursor: pointer;
	}

	button:hover {
		background: #1d4ed8;
	}

	button:active {
		background: #1e40af;
	}

	small {
		color: #666;
	}
</style>
