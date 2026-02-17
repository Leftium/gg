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

	// Wide table to test horizontal scrollbar (should not overflow panel)
	gg.table([
		{
			id: 1,
			firstName: 'Christopher',
			lastName: 'Washington',
			email: 'christopher.washington@example.com',
			phone: '+1-555-123-4567',
			address: '123 Long Street Name Avenue',
			city: 'San Francisco',
			state: 'CA',
			zipCode: '94102',
			country: 'United States'
		},
		{
			id: 2,
			firstName: 'Elizabeth',
			lastName: 'Montgomery',
			email: 'elizabeth.montgomery@example.com',
			phone: '+1-555-987-6543',
			address: '456 Another Very Long Address',
			city: 'Los Angeles',
			state: 'CA',
			zipCode: '90001',
			country: 'United States'
		}
	]);

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

export function testExpressions() {
	// Primitive values with expressions
	const count = 42;
	const name = 'Alice';
	const isActive = true;

	gg(count);
	gg(name);
	gg(isActive);
	gg(count + 10);
	gg(name.toUpperCase());

	// Object with expression
	const user = { name: 'Bob', age: 25 };
	gg(user);
	gg(user.name);

	// Array with expression
	const items = ['apple', 'banana', 'cherry'];
	gg(items);
	gg(items.length);

	gg.info('Toggle the Expr button in the toolbar to see expressions inline and in clipboard!');
}

export function testNamespaceSegments() {
	// Generate test data with multi-level namespaces to demonstrate clickable segments
	const messages = [
		'Processing request',
		'Data loaded successfully',
		'Updating state',
		'Rendering component',
		'API call completed',
		'Event triggered',
		'Validation passed',
		'Cache hit'
	];

	// rift namespace hierarchy (gg: prefix is added automatically)
	gg.ns('rift:transcription:interim', messages[0], { confidence: 0.85 });
	gg.ns('rift:transcription:final', messages[1], { confidence: 0.98 });
	gg.ns('rift:audio:recording', messages[2], { duration: '1.2s' });
	gg.ns('rift:audio:playback', messages[3], { volume: 0.8 });
	gg.ns('rift:websocket:connect', messages[4], { url: 'ws://localhost' });
	gg.ns('rift:websocket:message', messages[5], { type: 'audio' });

	// routes namespace hierarchy
	gg.ns('routes:home:load', messages[6]);
	gg.ns('routes:home:render', messages[7]);
	gg.ns('routes:about:load', messages[0]);

	// components namespace hierarchy
	gg.ns('components:header:mount', messages[1]);
	gg.ns('components:footer:mount', messages[2]);

	// api namespace hierarchy
	gg.ns('api:users:fetch', messages[3], { count: 10 });
	gg.ns('api:users:create', messages[4], { id: 42 });
	gg.ns('api:posts:list', messages[5], { page: 1 });

	// utils namespace hierarchy
	gg.ns('utils:format:date', messages[6], { format: 'ISO8601' });
	gg.ns('utils:format:currency', messages[7], { locale: 'en-US' });

	// Test new delimiters: @ / - _
	gg.ns('routes/dashboard/settings/+page.svelte@handleSubmit', messages[0], { action: 'save' });
	gg.ns('routes/dashboard/settings/+page.svelte@handleCancel', messages[1], { action: 'cancel' });
	gg.ns('routes/dashboard/profile/+page.svelte@onMount', messages[2], { loaded: true });
	gg.ns('api-client:fetch_user_data@handle-error', messages[3], { status: 404 });
	gg.ns('user-profile-card:render_avatar@click-handler', messages[4], { userId: 123 });
	gg.ns('payment_processor:process-transaction@validate_card', messages[5], { valid: true });

	gg.info('Generated 22 test logs with multi-delimiter namespaces. Click any segment to filter!');
}

// ---------------------------------------------------------------------------
// Stress test — simulates the rift-local WS flood bug
// ---------------------------------------------------------------------------

let stressAbort = false;

/**
 * Fire 3000 gg() calls as fast as possible using requestAnimationFrame,
 * batching multiple calls per frame to simulate a realistic WS message flood.
 * Returns a function to abort the run.
 */
export function stressTest(onDone?: () => void): () => void {
	const total = 3000;
	const perFrame = 10; // messages per rAF tick — simulates burst of WS msgs
	let i = 0;
	stressAbort = false;
	const startTime = performance.now();
	let lastTime = startTime;

	gg.info(`Stress test: firing ${total} messages (${perFrame}/frame)…`);

	function tick() {
		if (stressAbort || i >= total) {
			const elapsed = (performance.now() - startTime).toFixed(0);
			gg.info(`Stress test done: ${i}/${total} msgs in ${elapsed} ms`);
			onDone?.();
			return;
		}
		const end = Math.min(i + perFrame, total);
		for (; i < end; i++) {
			const now = performance.now();
			const delta = (now - lastTime).toFixed(1);
			const elapsed = ((now - startTime) / 1000).toFixed(1);
			lastTime = now;
			gg(`Stress #${String(i + 1).padStart(4, '0')}/${total}  +${delta}ms  @${elapsed}s`);
		}
		requestAnimationFrame(tick);
	}

	requestAnimationFrame(tick);

	return () => {
		stressAbort = true;
	};
}
