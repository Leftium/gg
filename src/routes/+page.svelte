<script lang="ts">
	import { gg } from '$lib/index.js';
	import OpenInEditorLink from '$lib/OpenInEditorLink.svelte';

	gg(
		"Hello, again! This logg's color differs because the callpoint's file and/or function differ."
	);

	// gg() with no arguments returns call-site info for open-in-editor
	const ggResult = gg();
</script>

<OpenInEditorLink url={ggResult.url} fileName={ggResult.fileName} />

<div>
	<h1>gg() demo/test site</h1>

	Open the browser dev console or Eruda's GG tab to check the output of gg().
</div>
