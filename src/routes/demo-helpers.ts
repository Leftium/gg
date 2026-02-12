/**
 * Demo helper functions for testing gg() features.
 * Imported from +page.svelte to demonstrate that gg() call-site
 * metadata works correctly from imported .ts files too.
 */
import { gg, fg, bg } from '$lib/index.js';

export function testManualNs() {
	// Plain label (no template variables) - used as-is
	gg.ns('CUSTOM_NAMESPACE', 'Plain custom namespace - no @functionName appended');

	// Template variables demo
	gg.ns('ERROR:$NS', 'Error with auto-generated callpoint suffix');
	gg.ns('$FILE:validation', 'File path with custom tag');
	gg.ns('TRACE:$FN', 'Custom prefix with just function name');
	gg.ns('$NS:debug', 'Full callpoint with custom suffix');

	// Multiple calls with same custom namespace (grouped by color)
	gg.ns('CUSTOM_NAMESPACE', 'Message 1');
	gg.ns('CUSTOM_NAMESPACE', 'Message 2', { data: Date.now() });
}

export function testAnsiColors() {
	// Test raw ANSI codes
	gg('\x1b[41mRaw ANSI red\x1b[0m normal text');

	// Test new fg/bg helpers - simple usage
	gg(bg('yellow')`Yellow background`);
	gg(fg('cyan')`Cyan text`);

	// Test method chaining fg + bg (order doesn't matter)
	gg(fg('white').bg('red')`Critical error!`);
	gg(bg('green').fg('white')`Success message`);

	// Define reusable color schemes with chaining
	const input = fg('blue').bg('yellow');
	const transcript = bg('green').fg('white');
	const error = fg('white').bg('red');

	gg(input`User input message`);
	gg(transcript`AI transcript response`);
	gg(error`Error message!`);

	// Test mixing inline
	gg(fg('red')`Error: ` + bg('yellow')`warning` + ' normal text');

	// Test custom hex colors with chaining
	gg(fg('#ff6347').bg('#98fb98')`Tomato on pale green`);
}
