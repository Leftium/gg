import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import devtoolsJson from 'vite-plugin-devtools-json';
import ggPlugins from './src/lib/vite.js';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@leftium\/gg$/,
				replacement: fileURLToPath(new URL('./src/lib/index.ts', import.meta.url))
			}
		]
	},
	plugins: [
		sveltekit({
			preprocess: vitePreprocess(),
			adapter: adapter()
		}),
		...ggPlugins(),
		devtoolsJson()
	],
	test: {
		include: ['src/**/*.test.ts']
	}
});
