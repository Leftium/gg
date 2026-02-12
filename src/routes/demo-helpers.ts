/**
 * Demo helper functions for testing gg() features.
 * Imported from +page.svelte to demonstrate that gg() call-site
 * metadata works correctly from imported .ts files too.
 */
import { gg, fg, bg, bold, italic, underline, dim } from '$lib/index.js';

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

export function testTextStyling() {
	// Standalone text styles
	gg(bold()`Bold text`);
	gg(italic()`Italic text`);
	gg(underline()`Underlined text`);
	gg(dim()`Dimmed text`);

	// Combined with colors
	gg(fg('red').bold()`Bold red error`);
	gg(fg('green').bold()`Bold green success`);
	gg(bg('yellow').italic()`Italic on yellow background`);
	gg(fg('blue').bg('white').underline()`Blue underlined on white`);
	gg(fg('gray').dim()`Dimmed gray text`);

	// Multiple styles chained
	gg(bold().italic()`Bold and italic`);
	gg(bold().underline()`Bold and underlined`);
	gg(fg('red').bold().underline()`Bold underlined red`);
	gg(fg('white').bg('blue').bold().italic()`All styles combined`);

	// Reusable style presets
	const finalStyle = fg('green').bold();
	const interimStyle = fg('gray');

	gg(finalStyle`final` + ' seg=0 "my name is John Kim Murphy" 96%');
	gg(interimStyle`interim` + ' seg=0 "my name is John Kim Murphy" 90%');

	// Mixed inline styling
	gg(bold()`Important:` + ' normal text ' + italic()`with emphasis`);
	gg(fg('red').bold()`Error:` + ' ' + underline()`Connection failed`);
}

export function testInfo() {
	// gg.info - informational level (blue badge)
	gg.info('System startup complete');
	gg.info('Connected to database', { host: 'localhost', port: 5432 });
	gg.info('Configuration loaded', { env: 'development', debug: true });

	// Passthrough demo: info returns the first argument
	const config = gg.info({ theme: 'dark', locale: 'en-US' });
	gg(`info returned:`, config);
}

export function testWarnError() {
	// gg.warn - warning level
	gg.warn('This API is deprecated, use v2 instead');
	gg.warn('Slow query detected', { duration: 3200, query: 'SELECT * FROM users' });

	// gg.error - error level with automatic stack capture
	gg.error('Connection to database failed');
	gg.error('Unexpected response', { status: 500, body: 'Internal Server Error' });

	// gg.error with an actual Error object (uses its .stack)
	try {
		JSON.parse('not json{');
	} catch (err) {
		gg.error(err);
	}

	// Passthrough demo: warn/error return the first argument
	const value = gg.warn('returning this value');
	gg(`warn returned: ${value}`);
}

export function testAssert() {
	const users = [{ name: 'Alice' }, { name: 'Bob' }];
	const emptyList: unknown[] = [];

	// Passing assertion - no output
	gg.assert(users.length > 0, 'users should not be empty');

	// Failing assertion - logs error with stack trace
	gg.assert(emptyList.length > 0, 'list should not be empty', emptyList);

	// Failing with no message - defaults to "Assertion failed"
	gg.assert(false);

	// Passthrough: returns the condition value
	const result = gg.assert(42, 'this passes');
	gg(`assert returned: ${result}`);
}

export function testTable() {
	// Array of objects
	gg.table([
		{ name: 'Alice', age: 30, role: 'admin' },
		{ name: 'Bob', age: 25, role: 'user' },
		{ name: 'Charlie', age: 35, role: 'moderator' }
	]);

	// Array of primitives
	gg.table(['apple', 'banana', 'cherry']);

	// Object of objects
	gg.table({
		us: { currency: 'USD', population: '331M' },
		uk: { currency: 'GBP', population: '67M' },
		jp: { currency: 'JPY', population: '125M' }
	});

	// With column filter
	gg.table(
		[
			{ name: 'Alice', age: 30, role: 'admin', email: 'alice@example.com' },
			{ name: 'Bob', age: 25, role: 'user', email: 'bob@example.com' }
		],
		['name', 'role']
	);

	// Passthrough: returns the original data
	const data = gg.table([{ x: 1 }, { x: 2 }]);
	gg('table returned:', data);
}

export function testTimers() {
	// Basic timer
	gg.time('demo');

	setTimeout(() => {
		gg.timeLog('demo', 'checkpoint 1');
	}, 100);

	setTimeout(() => {
		gg.timeLog('demo', 'checkpoint 2');
	}, 250);

	setTimeout(() => {
		gg.timeEnd('demo');
	}, 500);

	// Non-existent timer warning
	gg.timeEnd('nope');

	// Immediate timer (near-zero elapsed)
	gg.time('instant');
	gg.timeEnd('instant');
}

export function testTrace() {
	function innerFunction() {
		function deeplyNested() {
			// Trace captures the full call stack
			gg.trace('Trace from deeply nested function');
		}
		deeplyNested();
	}
	innerFunction();

	// Passthrough
	const val = gg.trace('trace returns this', { extra: 'data' });
	gg(`trace returned: ${val}`);
}
