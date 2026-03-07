import type { Plugin } from 'vite';
import ggCallSitesPlugin from './gg-call-sites-plugin.js';
import type { GgCallSitesPluginOptions } from './gg-call-sites-plugin.js';
import openInEditorPlugin from './open-in-editor.js';
import ggFileSinkPlugin from './gg-file-sink-plugin.js';
import type { GgFileSinkOptions } from './gg-file-sink-plugin.js';

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

	/**
	 * Enable the file sink plugin — writes all gg() entries to `.gg/logs-{port}.jsonl`
	 * for coding agent access. Exposes `GET`/`DELETE /__gg/logs` for agent workflows.
	 * Set to `false` to disable.
	 * @default true
	 */
	fileSink?: boolean | GgFileSinkOptions;
}

/**
 * All gg Vite plugins bundled together.
 *
 * Includes:
 * - `ggCallSitesPlugin` — rewrites `gg()` calls with source file/line/col metadata
 * - `openInEditorPlugin` — adds `/__open-in-editor` dev server middleware
 * - `ggFileSinkPlugin` — writes gg() entries to `.gg/logs-{port}.jsonl` for agent access
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

	plugins.push(ggCallSitesPlugin(options.callSites));

	if (options.openInEditor !== false) {
		plugins.push(openInEditorPlugin());
	}

	if (options.fileSink !== false) {
		const fileSinkOptions = typeof options.fileSink === 'object' ? options.fileSink : {};
		plugins.push(ggFileSinkPlugin(fileSinkOptions));
	}

	return plugins;
}

// Allow granular imports for advanced users
export { ggCallSitesPlugin, openInEditorPlugin, ggFileSinkPlugin };
export type { GgCallSitesPluginOptions, GgFileSinkOptions };
