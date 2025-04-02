import { openInEditorPlugin } from './src/lib/index.js';

import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), openInEditorPlugin()]
});
