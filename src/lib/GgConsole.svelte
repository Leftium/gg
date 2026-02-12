<script lang="ts">
	import { onMount } from 'svelte';
	import type { GgErudaOptions } from './eruda/types.js';

	let { prod, maxEntries, erudaOptions }: GgErudaOptions = $props();

	onMount(() => {
		import('./eruda/index.js').then(({ initGgEruda }) => {
			initGgEruda({ prod, maxEntries, erudaOptions });
		});
	});
</script>
