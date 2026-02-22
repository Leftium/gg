/**
 * Demo helper functions for testing gg() features.
 * Imported from +page.svelte to demonstrate that gg() call-site
 * metadata works correctly from imported .ts files too.
 */
import { gg, fg, bg, bold, italic, underline, dim } from '$lib/index.js';

export function testManualNs() {
	// Plain label (no template variables) - used as-is
	gg('Plain custom namespace - no @functionName appended').ns('CUSTOM_NAMESPACE');

	// Template variables demo
	gg('Error with auto-generated callpoint suffix').ns('ERROR:$NS');
	gg('File path with custom tag').ns('$FILE:validation');
	gg('Custom prefix with just function name').ns('TRACE:$FN');
	gg('Full callpoint with custom suffix').ns('$NS:debug');

	// Multiple calls with same custom namespace (grouped by color)
	gg('Message 1').ns('CUSTOM_NAMESPACE');
	gg('Message 2', { data: Date.now() }).ns('CUSTOM_NAMESPACE');
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
	// gg().info() - informational level (blue badge)
	gg('System startup complete').info();
	gg('Connected to database', { host: 'localhost', port: 5432 }).info();
	gg('Configuration loaded', { env: 'development', debug: true }).info();

	// Passthrough demo: .v returns the first argument
	const config = gg({ theme: 'dark', locale: 'en-US' }).info().v;
	gg(`info returned:`, config);
}

export function testWarnError() {
	// .warn() - warning level
	gg('This API is deprecated, use v2 instead').warn();
	gg('Slow query detected', { duration: 3200, query: 'SELECT * FROM users' }).warn();

	// .error() - error level with automatic stack capture
	gg('Connection to database failed').error();
	gg('Unexpected response', { status: 500, body: 'Internal Server Error' }).error();

	// .error() with an actual Error object (uses its .stack)
	try {
		JSON.parse('not json{');
	} catch (err) {
		gg(err).error();
	}

	// Passthrough demo: .v returns the first argument
	const value = gg('returning this value').warn().v;
	gg(`warn returned: ${value}`);
}

export function testTable() {
	// Array of objects
	gg([
		{ name: 'Alice', age: 30, role: 'admin' },
		{ name: 'Bob', age: 25, role: 'user' },
		{ name: 'Charlie', age: 35, role: 'moderator' }
	]).table();

	// Array of primitives
	gg(['apple', 'banana', 'cherry']).table();

	// Object of objects
	gg({
		us: { currency: 'USD', population: '331M' },
		uk: { currency: 'GBP', population: '67M' },
		jp: { currency: 'JPY', population: '125M' }
	}).table();

	// With column filter
	gg([
		{ name: 'Alice', age: 30, role: 'admin', email: 'alice@example.com' },
		{ name: 'Bob', age: 25, role: 'user', email: 'bob@example.com' }
	]).table(['name', 'role']);

	// Wide table to test horizontal scrollbar (should not overflow panel)
	gg([
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
	]).table();

	// Passthrough: .v returns the original data
	const data = gg([{ x: 1 }, { x: 2 }]).table().v;
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

	// Timer with custom namespace
	gg.time('ns-demo').ns('custom-timer-group');
	setTimeout(() => {
		gg.timeEnd('ns-demo');
	}, 200);
}

export function testTrace() {
	function innerFunction() {
		function deeplyNested() {
			// Trace captures the full call stack
			gg('Trace from deeply nested function').trace();
		}
		deeplyNested();
	}
	innerFunction();

	// Passthrough
	const val = gg('trace returns this', { extra: 'data' }).trace().v;
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

	gg('Toggle the Expr button in the toolbar to see expressions inline and in clipboard!').info();
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
	gg(messages[0], { confidence: 0.85 }).ns('rift:transcription:interim');
	gg(messages[1], { confidence: 0.98 }).ns('rift:transcription:final');
	gg(messages[2], { duration: '1.2s' }).ns('rift:audio:recording');
	gg(messages[3], { volume: 0.8 }).ns('rift:audio:playback');
	gg(messages[4], { url: 'ws://localhost' }).ns('rift:websocket:connect');
	gg(messages[5], { type: 'audio' }).ns('rift:websocket:message');

	// routes namespace hierarchy
	gg(messages[6]).ns('routes:home:load');
	gg(messages[7]).ns('routes:home:render');
	gg(messages[0]).ns('routes:about:load');

	// components namespace hierarchy
	gg(messages[1]).ns('components:header:mount');
	gg(messages[2]).ns('components:footer:mount');

	// api namespace hierarchy
	gg(messages[3], { count: 10 }).ns('api:users:fetch');
	gg(messages[4], { id: 42 }).ns('api:users:create');
	gg(messages[5], { page: 1 }).ns('api:posts:list');

	// utils namespace hierarchy
	gg(messages[6], { format: 'ISO8601' }).ns('utils:format:date');
	gg(messages[7], { locale: 'en-US' }).ns('utils:format:currency');

	// Test new delimiters: @ / - _
	gg(messages[0], { action: 'save' }).ns('routes/dashboard/settings/+page.svelte@handleSubmit');
	gg(messages[1], { action: 'cancel' }).ns('routes/dashboard/settings/+page.svelte@handleCancel');
	gg(messages[2], { loaded: true }).ns('routes/dashboard/profile/+page.svelte@onMount');
	gg(messages[3], { status: 404 }).ns('api-client:fetch_user_data@handle-error');
	gg(messages[4], { userId: 123 }).ns('user-profile-card:render_avatar@click-handler');
	gg(messages[5], { valid: true }).ns('payment_processor:process-transaction@validate_card');

	gg('Generated 22 test logs with multi-delimiter namespaces. Click any segment to filter!').info();
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

	gg(`Stress test: firing ${total} messages (${perFrame}/frame)…`).info();

	const splitAt = 2000; // buffer capacity
	let splitTime = 0;

	function tick() {
		if (stressAbort || i >= total) {
			const now = performance.now();
			const totalMs = (now - startTime).toFixed(0);
			const preMs = (splitTime - startTime).toFixed(0);
			const postMs = (now - splitTime).toFixed(0);
			gg(
				`Stress test done: ${i}/${total} in ${totalMs}ms — first ${splitAt}: ${preMs}ms, remaining ${total - splitAt}: ${postMs}ms`
			).info();
			onDone?.();
			return;
		}
		const end = Math.min(i + perFrame, total);
		for (; i < end; i++) {
			if (i === splitAt) splitTime = performance.now();
			const now = performance.now();
			const delta = (now - lastTime).toFixed(1);
			const elapsed = ((now - startTime) / 1000).toFixed(1);
			lastTime = now;
			gg(`Stress #${String(i + 1).padStart(4, '0')}/${total}  @${elapsed}s  +${delta}ms`);
		}
		requestAnimationFrame(tick);
	}

	requestAnimationFrame(tick);

	return () => {
		stressAbort = true;
	};
}
