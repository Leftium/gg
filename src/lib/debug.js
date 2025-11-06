/**
 * Re-export patched debug library
 * This file bundles the patched version of debug into the library distribution.
 * 
 * The patch moves time diff display before namespace:
 *   Standard: gg:file +123ms
 *   Patched:  +123ms gg:file
 */

// The debug/src/index.js handles browser vs node environment detection
// Import CommonJS module and re-export as ES module default
import debugModule from './debug/src/index.js';
export default debugModule;
