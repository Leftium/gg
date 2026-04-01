import type { Plugin } from 'vite';

// Based on: https://github.com/yyx990803/launch-editor/blob/master/packages/launch-editor-middleware/index.js

import * as url from 'url';
import * as path from 'path';
import launch from 'launch-editor';

export default function openInEditorPlugin(
	specifiedEditor?: undefined,
	srcRoot?: string | undefined,
	onErrorCallback?: ((fileName: string, errorMessage: string | null) => void) | undefined
): Plugin {
	if (typeof specifiedEditor === 'function') {
		onErrorCallback = specifiedEditor;
		specifiedEditor = undefined;
	}

	if (typeof srcRoot === 'function') {
		onErrorCallback = srcRoot;
		srcRoot = undefined;
	}

	srcRoot = srcRoot || process.cwd();

	return {
		name: 'open-in-editor',
		configureServer(server) {
			// Expose dev server port via globalThis so gg.ts can build the
			// openInEditorUrlTemplate without importing Node's http module.
			// (gg-file-sink-plugin also sets this; whichever fires first wins.)
			server.httpServer?.once('listening', () => {
				const addr = server.httpServer?.address();
				const port =
					addr && typeof addr === 'object' ? addr.port : (server.config.server.port ?? 5173);
				(globalThis as Record<string, unknown>).__ggDevServerPort ??= port;
			});

			server.middlewares.use('/__open-in-editor', (req, res) => {
				const { file, line, col, editor } = url.parse(req.url || '', true).query || {};
				if (!file) {
					res.statusCode = 500;
					res.end(`open-in-editor-plugin: required query param "file" is missing.`);
				} else {
					res.statusCode = 222;
					// launch-editor supports file:line:col format for cursor positioning
					let fileArg = path.resolve(srcRoot, file as string);
					if (line) fileArg += `:${line}`;
					if (line && col) fileArg += `:${col}`;
					// Use editor from query param if provided, otherwise fall back to plugin config
					const editorToUse = typeof editor === 'string' && editor ? editor : specifiedEditor;
					launch(fileArg, editorToUse, onErrorCallback);
					res.end('<p>You may safely close this window.</p><script>window.close()</script>');
				}
			});

			// Expose project root for client-side $ROOT variable (forward slashes for URI compat)
			server.middlewares.use('/__gg/project-root', (_req, res) => {
				res.setHeader('Content-Type', 'text/plain');
				res.end(srcRoot.replace(/\\/g, '/'));
			});
		}
	};
}
