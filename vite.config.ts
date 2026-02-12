import devtoolsJson from 'vite-plugin-devtools-json';
import ggPlugins from './src/lib/vite.js';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit(), ...ggPlugins(), devtoolsJson()],
	test: {
		include: ['src/**/*.test.ts']
	}
});
