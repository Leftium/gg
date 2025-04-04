<script lang="ts">
	import { dev } from '$app/environment';

	let { ggResult } = $props();

	// svelte-ignore non_reactive_update
	let iframeElement: HTMLIFrameElement;

	function onclick(event: MouseEvent) {
		iframeElement.src = ggResult.url;
		event.preventDefault();
	}
</script>

{#if dev}
	[📝<a
		{onclick}
		href={ggResult.url}
		title={`${ggResult.fileName}@${ggResult.functionName}`}
		target="_open-in-editor"
		class="open-in-editor-link"
	>
		{ggResult.fileName}
	</a>
	👀]

	<iframe bind:this={iframeElement} title="" hidden></iframe>
{/if}
