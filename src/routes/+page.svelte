<script lang="ts">
	import { gg } from '$lib/index.js';
	import OpenInEditorLink from '$lib/OpenInEditorLink.svelte';
	import type ErrorStackParser from 'error-stack-parser';

	gg(
		"Hello, again! This logg's color differs because the callpoint's file and/or function differ."
	);

	// gg() without arguments outputs a link that causes
	// vite to open this file in an editor (like VS Code.)
	gg('The link below opens a different file in your editor:');
	const ggResult = gg();

	gg('Examine the call stack returned when gg() is called without arguments:');
	console.table(ggResult.stack.map(tidyStackFrame));

	// Utility function just to reorder and shorten fields:
	function tidyStackFrame(stackframe: ErrorStackParser.StackFrame) {
		let { fileName: filename, functionName } = stackframe;

		const maxLength = 40;
		filename = (filename || '').replace(/(\?(t|v)=\d+e?)?$/, '');
		filename = `${filename.length > maxLength ? '...' : ''}${filename?.slice(-maxLength)}`;

		return { function: functionName, filename };
	}
</script>

<OpenInEditorLink {ggResult} />

<div>
	<h1>gg() demo/test site</h1>

	Open the browser dev console to check the output of gg().
</div>

<pre>{JSON.stringify(ggResult.stack.map(tidyStackFrame), null, 4)}</pre>
