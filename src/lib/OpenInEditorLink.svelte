<script lang="ts">
	import { dev } from '$app/environment';

	let {
		url,
		fileName,
		title = fileName
	}: { url: string; fileName: string; title?: string } = $props();

	// svelte-ignore non_reactive_update
	let iframeElement: HTMLIFrameElement;

	function onclick(event: MouseEvent) {
		iframeElement.src = url;
		event.preventDefault();
	}
</script>

{#if dev}
	[📝<a {onclick} href={url} {title} target="_open-in-editor" class="open-in-editor-link">
		{fileName}
	</a>
	👀]

	<iframe bind:this={iframeElement} title="" hidden></iframe>
{/if}
