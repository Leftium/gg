/**
 * Re-export patched debug library  
 * This file bundles the patched version of debug into the library distribution.
 * 
 * The patch moves time diff display before namespace:
 *   Standard: gg:file +123ms
 *   Patched:  +123ms gg:file
 * 
 * Note: In dev mode with Vite, this uses the debug from node_modules (with patch applied).
 * In production (svelte-package build), this bundles the ./debug/ folder into dist/.
 */

// Import from debug package (works in dev with Vite optimizeDeps)
// After svelte-package, this will bundle from ./debug/ folder
import debug from 'debug';

export default debug;
