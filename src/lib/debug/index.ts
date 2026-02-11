/**
 * Debug entry point — selects browser or node implementation.
 *
 * Re-exports the DebugFactory and Debugger types for consumers.
 */

import { BROWSER } from 'esm-env';
import type { DebugFactory } from './common.js';

export type { DebugFactory, Debugger } from './common.js';

// Conditional import: browser.ts for browsers, node.ts for Node/Deno/Bun
const { default: debug } = BROWSER
	? await import('./browser.js')
	: await import('./node.js');

export default debug as DebugFactory;
