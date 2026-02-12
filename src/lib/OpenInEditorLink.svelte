<script lang="ts">
	import { dev } from '$app/environment';

	type GgCallSiteInfo = { fileName: string; functionName: string; url: string };

	let {
		gg,
		url = gg?.url,
		fileName = gg?.fileName,
		title = gg ? `${gg.fileName}@${gg.functionName}` : fileName
	}: {
		gg?: GgCallSiteInfo;
		url?: string;
		fileName?: string;
		title?: string;
	} = $props();

	// svelte-ignore non_reactive_update
	let iframeElement: HTMLIFrameElement;

	function onclick(event: MouseEvent) {
		if (url) {
			iframeElement.src = url;
			event.preventDefault();
		}
	}
</script>

{#if dev && fileName}
	[📝<a {onclick} href={url} {title} target="_open-in-editor" class="open-in-editor-link">
		{fileName}
	</a>
	👀]

	<iframe bind:this={iframeElement} title="" hidden></iframe>
{/if}
