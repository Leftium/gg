import { openInEditorPlugin } from './src/lib/index.js';

import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), openInEditorPlugin()],
	build: {
		target: 'es2022' // or 'esnext' for bleeding-edge features
	},
	optimizeDeps: {
		esbuildOptions: {
			target: 'es2022',
			supported: {
				'top-level-await': true
			}
		}
	}
});
