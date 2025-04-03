<script lang="ts">
	import type { Snippet } from 'svelte';
	import { gg } from '$lib/index.js';
	import OpenInEditorLink from '$lib/OpenInEditorLink.svelte';

	let { children }: { children: Snippet } = $props();

	gg('Hello, gg!!');
	gg(
		'The colored annotation to the left is the *callpoint*, indicating the location of this logg. (As filename@function)'
	);

	// gg() without arguments outputs a link that causes
	// vite to open this file in an editor (like VS Code.)
	gg('The link below opens the file containing the callpoint in your editor:');
	const ggResult = gg();
</script>

<OpenInEditorLink {ggResult} />

<div>{@render children()}</div>
