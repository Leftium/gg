// Reexport your entry components here
//
// NOTE: Vite plugins (ggCallSitesPlugin, openInEditorPlugin, ggFileSinkPlugin)
// are intentionally NOT exported here. They are available via '@leftium/gg/vite'.
// Exporting them from the runtime entry drags svelte/compiler (via gg-call-sites-plugin)
// into the browser module graph, causing CJS/ESM errors with axobject-query when
// pre-bundling is bypassed.

import { gg, GgChain, GgTimerChain, fg, bg, bold, italic, underline, dim } from './gg.js';

export { default as GgConsole } from './GgConsole.svelte';
export { gg, GgChain, GgTimerChain, fg, bg, bold, italic, underline, dim };
