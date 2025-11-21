/**
 * Re-export patched debug library
 * This file bundles the patched version of debug into the library distribution.
 *
 * The patch moves time diff display before namespace:
 *   Standard: gg:file +123ms
 *   Patched:  +123ms gg:file
 */

// In dev mode: use debug from node_modules (with patch applied via pnpm)
// After build: this file is replaced by a direct import of the bundled version
// See: scripts/bundle-debug.js which creates dist/debug-bundled.js
import debug from 'debug';

export default debug;
