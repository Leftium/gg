import devtoolsJson from 'vite-plugin-devtools-json';
import { openInEditorPlugin, ggCallSitesPlugin } from './src/lib/index.js';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), ggCallSitesPlugin(), openInEditorPlugin(), devtoolsJson()],
	build: {
		target: 'es2022' // or 'esnext' for bleeding-edge features
	},
	optimizeDeps: {
		include: ['debug'],
		esbuildOptions: {
			target: 'es2022',
			supported: { 'top-level-await': true }
		}
	}
});
