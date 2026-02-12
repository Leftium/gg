import type { Plugin } from 'vite';
import ggCallSitesPlugin from './gg-call-sites-plugin.js';
import type { GgCallSitesPluginOptions } from './gg-call-sites-plugin.js';
import openInEditorPlugin from './open-in-editor.js';

export interface GgPluginsOptions {
	/**
	 * Options for the call-sites Vite plugin (source metadata rewriting).
	 * @default {}
	 */
	callSites?: GgCallSitesPluginOptions;

	/**
	 * Enable the open-in-editor Vite plugin (dev server middleware).
	 * Set to `false` to disable.
	 * @default true
	 */
	openInEditor?: boolean;
}

/**
 * All gg Vite plugins bundled together.
 *
 * Includes:
 * - `ggCallSitesPlugin` — rewrites `gg()` calls with source file/line/col metadata
 * - `openInEditorPlugin` — adds `/__open-in-editor` dev server middleware
 * - Automatic `es2022` build target (required for top-level await)
 *
 * @example
 * ```ts
 * import ggPlugins from '@leftium/gg/vite';
 *
 * export default defineConfig({
 *   plugins: [sveltekit(), ...ggPlugins()]
 * });
 * ```
 */
export default function ggPlugins(options: GgPluginsOptions = {}): Plugin[] {
	const plugins: Plugin[] = [];

	// Ensure es2022 target for top-level await support
	plugins.push({
		name: 'gg-config',
		config() {
			return {
				build: {
					target: 'es2022'
				},
				optimizeDeps: {
					esbuildOptions: {
						target: 'es2022',
						supported: { 'top-level-await': true }
					}
				}
			};
		}
	});

	plugins.push(ggCallSitesPlugin(options.callSites));

	if (options.openInEditor !== false) {
		plugins.push(openInEditorPlugin());
	}

	return plugins;
}

// Allow granular imports for advanced users
export { ggCallSitesPlugin, openInEditorPlugin };
export type { GgCallSitesPluginOptions };
