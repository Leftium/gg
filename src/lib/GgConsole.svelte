<script lang="ts">
	import { onMount } from 'svelte';
	import type { GgErudaOptions } from './eruda/types.js';

	let { prod, maxEntries, erudaOptions, open }: GgErudaOptions = $props();

	onMount(() => {
		import('./eruda/index.js').then(({ initGgEruda }) => {
			initGgEruda({ prod, maxEntries, erudaOptions, open });
		});
	});
</script>
