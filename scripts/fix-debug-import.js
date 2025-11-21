#!/usr/bin/env node

/**
 * Post-process script to fix debug.js import after svelte-package build
 *
 * Problem: src/lib/debug.js imports from 'debug' package (for dev mode)
 * Solution: After build, replace the import to use './debug-bundled.js' (for consumers)
 *
 * This ensures:
 * - Dev mode: Uses 'debug' from node_modules (with pnpm patch applied)
 * - Consumers: Get bundled patched version without needing to install debug
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const distDebugPath = join(__dirname, '../dist/debug.js');

try {
	// Read the built file
	let content = readFileSync(distDebugPath, 'utf8');

	// Replace the import statement
	const originalImport = "import debug from 'debug';";
	const replacedImport = "import debug from './debug-bundled.js';";

	if (content.includes(originalImport)) {
		content = content.replace(originalImport, replacedImport);
		writeFileSync(distDebugPath, content, 'utf8');
		console.log('✓ Fixed debug.js import: debug → ./debug-bundled.js');
	} else {
		console.warn('⚠ Warning: Could not find expected import statement in dist/debug.js');
		console.warn('  Expected:', originalImport);
	}
} catch (error) {
	console.error('✗ Error fixing debug import:', error.message);
	process.exit(1);
}
