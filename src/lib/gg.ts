import debugFactory, { debugReady, type Debugger } from './debug/index.js';
import { BROWSER, DEV } from 'esm-env';
import { toWordTuple } from './words.js';

/**
 * Compile-time flag set by ggCallSitesPlugin via Vite's `define` config.
 * When the plugin is installed, Vite replaces this with `true` at build time,
 * and all gg() calls are rewritten to gg._ns() with baked-in metadata.
 * Without the plugin, gg() falls back to word-tuple callpoint names.
 */
declare const __GG_TAG_PLUGIN__: boolean;
const _ggCallSitesPlugin = typeof __GG_TAG_PLUGIN__ !== 'undefined' ? __GG_TAG_PLUGIN__ : false;

/**
 * Creates a debug instance with custom formatArgs to add namespace padding
 * Padding is done at format time, not in the namespace itself, to keep colors stable
 */
function createGgDebugger(namespace: string): Debugger {
	const dbg = debugFactory(namespace);

	// Store the original formatArgs
	const originalFormatArgs = dbg.formatArgs;

	// Override formatArgs to add padding to the namespace display
	dbg.formatArgs = function (args: unknown[]) {
		// Call original formatArgs first
		if (originalFormatArgs) {
			originalFormatArgs.call(dbg, args);
		}

		// Extract the callpoint from namespace (strip 'gg:' prefix and any URL suffix)
		const nsMatch = dbg.namespace.match(/^gg:([^h]+?)(?:http|$)/);
		const callpoint = nsMatch ? nsMatch[1] : dbg.namespace.replace(/^gg:/, '');
		const paddedCallpoint = callpoint.padEnd(maxCallpointLength, ' ');

		// Replace the namespace in the formatted string with padded version
		if (typeof args[0] === 'string') {
			args[0] = args[0].replace(dbg.namespace, `gg:${paddedCallpoint}`);
		}
	};

	return dbg;
}

// Helper to detect if we're running in CloudFlare Workers
const isCloudflareWorker = (): boolean => {
	// Check for CloudFlare Workers-specific global
	const globalWithWorkerAPIs = globalThis as typeof globalThis & {
		WebSocketPair?: unknown;
	};
	return (
		typeof globalThis !== 'undefined' &&
		'caches' in globalThis &&
		typeof globalWithWorkerAPIs.WebSocketPair !== 'undefined'
	);
};

// Check if we're in CloudFlare Workers and warn early
if (isCloudflareWorker()) {
	console.warn('gg: CloudFlare not supported.');
}

// Type definitions for the modules
type DotenvModule = typeof import('dotenv');
type HttpModule = typeof import('http');
type AddressInfo = import('net').AddressInfo;

// Lazy-load Node.js modules to avoid top-level await (Safari compatibility).
// The imports start immediately but don't block module evaluation.
let dotenvModule: DotenvModule | null = null;
let httpModule: HttpModule | null = null;

function loadServerModules(): Promise<void> {
	if (isCloudflareWorker() || BROWSER) return Promise.resolve();

	return (async () => {
		try {
			dotenvModule = await import('dotenv');
		} catch {
			// dotenv not available — optional dependency
		}
		try {
			httpModule = await import('http');
		} catch {
			console.warn('gg: Node.js http module not available');
		}
	})();
}

// Start loading immediately (non-blocking)
const serverModulesReady = loadServerModules();

function findAvailablePort(startingPort: number): Promise<number> {
	if (!httpModule) return Promise.resolve(startingPort);

	return new Promise((resolve) => {
		const server = httpModule!.createServer();
		server.listen(startingPort, () => {
			const actualPort = (server?.address() as AddressInfo)?.port;
			server.close(() => resolve(actualPort));
		});
		server.on('error', () => {
			// If the port is in use, try the next one
			findAvailablePort(startingPort + 1).then(resolve);
		});
	});
}

function getServerPort(): Promise<string | number> {
	return new Promise((resolve) => {
		if (BROWSER) {
			// Browser environment
			const currentPort =
				window.location.port || (window.location.protocol === 'https:' ? '443' : '80');

			// Resolve the promise with the detected port
			resolve(currentPort);
		} else if (isCloudflareWorker()) {
			// CloudFlare Workers - return default port
			resolve('5173');
		} else {
			// Node.js environment — wait for http module to be available
			serverModulesReady.then(() => {
				const startingPort = Number(process?.env?.PORT) || 5173; // Default to Vite's default port
				findAvailablePort(startingPort).then((actualPort) => {
					resolve(actualPort);
				});
			});
		}
	});
}

// Port resolution starts immediately but doesn't block module evaluation.
// The template is updated asynchronously once the port is known.
let port: string | number = 5173; // Default fallback
void getServerPort().then((p) => {
	port = p;
	ggConfig.openInEditorUrlTemplate = `http://localhost:${port}/__open-in-editor?file=$FILENAME`;
});

/**
 * Determines if gg should be enabled based on environment and runtime triggers.
 *
 * Priority order:
 * 1. CloudFlare Workers → always disabled (no stack traces, no filesystem)
 * 2. ENV hard-disable → absolute override, no runtime enable possible
 * 3. DEV mode → always enabled
 * 4. PROD mode → requires runtime trigger (?gg URL param or localStorage)
 */
function isGgEnabled(): boolean {
	// CloudFlare Workers - hard disable (no Error stacks, no filesystem)
	if (isCloudflareWorker()) return false;

	// ENV hard-disable takes absolute precedence
	// Allows completely removing gg from production builds
	if (BROWSER) {
		if (
			typeof import.meta.env?.VITE_GG_ENABLED === 'string' &&
			import.meta.env.VITE_GG_ENABLED === 'false'
		) {
			return false;
		}
	} else {
		if (process?.env?.GG_ENABLED === 'false') {
			return false;
		}
	}

	// Development - always enabled (unless ENV explicitly disabled above)
	if (DEV) return true;

	// Production - requires runtime trigger (similar to Eruda widget loading)
	if (BROWSER) {
		// Check URL param (?gg)
		try {
			const params = new URLSearchParams(window.location.search);
			if (params.has('gg')) {
				// Persist the decision so it survives navigation
				localStorage.setItem('gg-enabled', 'true');
				return true;
			}
		} catch {
			// URLSearchParams or localStorage might not be available
		}

		// Check localStorage persistence
		try {
			if (localStorage.getItem('gg-enabled') === 'true') {
				return true;
			}
		} catch {
			// localStorage might not be available
		}
	}

	// Default: disabled in production without trigger
	return false;
}

const ggConfig = {
	enabled: isGgEnabled(),
	showHints: !isCloudflareWorker(), // Don't show hints in CloudFlare Workers
	editorLink: false,
	openInEditorUrlTemplate: `http://localhost:${port}/__open-in-editor?file=$FILENAME`,

	// The srcRoot contains all source files.
	// filename A        : http://localhost:5173/src/routes/+layout.svelte
	// filename B        : http://localhost:5173/src/lib/gg.ts
	// srcRootprefix     : http://localhost:5173/src/
	// <folderName> group:                       src
	srcRootPattern: '.*?(/(?<folderName>src|chunks)/)'
};
const srcRootRegex = new RegExp(ggConfig.srcRootPattern, 'i');

// To maintain unique millisecond diffs for each callpoint:
// - Create a unique log function for each callpoint.
// - Cache and reuse the same log function for a given callpoint.
const namespaceToLogFunction = new Map<string, Debugger>();
let maxCallpointLength = 0;

// Per-namespace prevTime for diff tracking (independent of debug library's enabled state,
// so GgConsole diffs are correct even when localStorage.debug doesn't include gg:*).
const namespaceToPrevTime = new Map<string, number>();

// Cache: raw stack line → word tuple (avoids re-hashing the same call site)
const stackLineCache = new Map<string, string>();

/**
 * Resolve the callpoint for the caller at the given stack depth.
 * depth=2 → caller of gg(), depth=3 → caller of gg.ns() (extra frame).
 */
function resolveCallpoint(depth: number): string {
	const rawStack = new Error().stack || '';
	const callerLine = rawStack.split('\n')[depth] || rawStack;
	const callerKey = callerLine.replace(/:\d+:\d+\)?$/, '').trim();

	const callpoint = stackLineCache.get(callerKey) ?? toWordTuple(callerKey);
	if (!stackLineCache.has(callerKey)) {
		stackLineCache.set(callerKey, callpoint);
	}

	if (callpoint.length < 80 && callpoint.length > maxCallpointLength) {
		maxCallpointLength = callpoint.length;
	}

	return callpoint;
}

/**
 * Reset the namespace width tracking.
 * Useful after configuration checks that may have long callpoint paths.
 */
function resetNamespaceWidth() {
	maxCallpointLength = 0;
}

function openInEditorUrl(fileName: string, line?: number, col?: number) {
	let url = ggConfig.openInEditorUrlTemplate.replace(
		'$FILENAME',
		encodeURIComponent(fileName).replaceAll('%2F', '/')
	);
	if (line != null) url += `&line=${line}`;
	if (col != null) url += `&col=${col}`;
	return url;
}

// http://localhost:5173/__open-in-editor?file=src%2Froutes%2F%2Bpage.svelte

/**
 * Hook for capturing gg() output (used by Eruda plugin)
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface CapturedEntry {
	namespace: string;
	color: string;
	diff: number; // Millisecond diff like +0ms, +123ms
	message: string;
	args: unknown[];
	timestamp: number;
	file?: string; // Source file path for open-in-editor
	line?: number; // Source line number
	col?: number; // Source column number
	src?: string; // Source expression text for icecream-style display
	level?: LogLevel; // Log severity level (default: 'debug')
	stack?: string; // Stack trace string (for error/trace calls)
	tableData?: { keys: string[]; rows: Array<Record<string, unknown>> }; // Structured table data
}

type OnLogCallback = (entry: CapturedEntry) => void;

// Overload signatures
export function gg(): {
	fileName: string;
	functionName: string;
	url: string;
};
export function gg<T>(arg: T, ...args: unknown[]): T;

export function gg(...args: unknown[]) {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		return args.length ? args[0] : { fileName: '', functionName: '', url: '' };
	}

	// Without the call-sites plugin, use cheap stack hash → deterministic word tuple.
	// When the plugin IS installed, all gg() calls are rewritten to gg._ns() at build time,
	// so this code path only runs for un-transformed calls (i.e. plugin not installed).
	// Same call site always produces the same word pair (e.g. "calm-fox").
	// depth=2: skip "Error" header [0] and gg() frame [1]
	const callpoint = resolveCallpoint(2);
	return ggLog({ ns: callpoint }, ...args);
}

/**
 * gg.ns() - Log with an explicit namespace (callpoint label).
 *
 * Users call gg.ns() directly to set a meaningful label that survives
 * across builds. For the internal plugin-generated version with file
 * metadata, see gg._ns().
 *
 * The label supports template variables (substituted by the vite plugin
 * at build time, or at runtime for $NS):
 *   $NS   - auto-generated callpoint (file@fn with plugin, word-tuple without)
 *   $FN   - enclosing function name (plugin only, empty without)
 *   $FILE - short file path (plugin only, empty without)
 *   $LINE - line number (plugin only, empty without)
 *   $COL  - column number (plugin only, empty without)
 *
 * @param nsLabel - The namespace label (appears as gg:<nsLabel> in output)
 * @param args - Same arguments as gg()
 * @returns Same as gg() - the first arg, or call-site info if no args
 *
 * @example
 * gg.ns("auth", "login failed")        // → gg:auth
 * gg.ns("ERROR:$NS", msg)              // → gg:ERROR:routes/+page.svelte@handleClick (with plugin)
 *                                       // → gg:ERROR:calm-fox (without plugin)
 * gg.ns("$NS:validation", fieldName)   // → gg:routes/+page.svelte@handleClick:validation
 */
gg.ns = function (nsLabel: string, ...args: unknown[]): unknown {
	// Resolve $NS at runtime (word-tuple fallback when plugin isn't installed).
	// With the plugin, $NS is already substituted at build time before this runs.
	// depth=3: skip "Error" [0], resolveCallpoint [1], gg.ns [2] → caller [3]
	if (nsLabel.includes('$NS')) {
		const callpoint = resolveCallpoint(3);
		nsLabel = nsLabel.replace(/\$NS/g, callpoint);
	}
	return gg._ns({ ns: nsLabel }, ...args);
};

/** Internal options for the core log function */
interface LogOptions {
	ns: string;
	file?: string;
	line?: number;
	col?: number;
	src?: string;
	level?: LogLevel;
	stack?: string;
	tableData?: { keys: string[]; rows: Array<Record<string, unknown>> };
}

/**
 * Core logging function shared by all gg methods.
 *
 * All public methods (gg, gg.ns, gg.warn, gg.error, gg.table, etc.)
 * funnel through this function. It handles namespace resolution,
 * debug output, capture hook, and passthrough return.
 */
function ggLog(options: LogOptions, ...args: unknown[]): unknown {
	const { ns: nsLabel, file, line, col, src, level, stack, tableData } = options;

	if (!ggConfig.enabled || isCloudflareWorker()) {
		return args.length ? args[0] : { fileName: '', functionName: '', url: '' };
	}

	const namespace = `gg:${nsLabel}`;

	if (nsLabel.length < 80 && nsLabel.length > maxCallpointLength) {
		maxCallpointLength = nsLabel.length;
	}

	const ggLogFunction =
		namespaceToLogFunction.get(namespace) ||
		namespaceToLogFunction.set(namespace, createGgDebugger(namespace)).get(namespace)!;

	// Prepare args for logging (console output is value-only; src is carried
	// on CapturedEntry for the Eruda UI to display on hover)
	let logArgs: unknown[];
	let returnValue: unknown;

	if (!args.length) {
		// No arguments: return call-site info for open-in-editor
		const fileName = file ? file.replace(srcRootRegex, '') : nsLabel;
		const functionName = nsLabel.includes('@') ? nsLabel.split('@').pop() || '' : '';
		const url = file ? openInEditorUrl(file, line, col) : '';
		logArgs = [`    📝 ${nsLabel}`];
		returnValue = { fileName, functionName, url };
	} else if (args.length === 1) {
		logArgs = [args[0]];
		returnValue = args[0];
	} else {
		logArgs = [args[0], ...args.slice(1)];
		returnValue = args[0];
	}

	// Add level prefix emoji for info/warn/error
	if (level === 'info') {
		logArgs[0] = `ℹ️ ${logArgs[0]}`;
	} else if (level === 'warn') {
		logArgs[0] = `⚠️ ${logArgs[0]}`;
	} else if (level === 'error') {
		logArgs[0] = `⛔ ${logArgs[0]}`;
	}

	// Compute diff independently of the debug library's enabled state.
	// ggLogFunction.diff only updates when the debugger is enabled (i.e. localStorage.debug
	// matches the namespace), so relying on it would always show +0ms when console output is
	// disabled — even though the GgConsole panel always captures entries.
	const now = performance.now();
	const prevTime = namespaceToPrevTime.get(namespace);
	const diff = prevTime !== undefined ? now - prevTime : 0;
	namespaceToPrevTime.set(namespace, now);

	// Log to console via debug
	if (logArgs.length === 1) {
		ggLogFunction(logArgs[0]);
	} else {
		ggLogFunction(logArgs[0], ...logArgs.slice(1));
	}

	// Call capture hook if registered (for Eruda plugin)
	const entry: CapturedEntry = {
		namespace,
		color: ggLogFunction.color,
		diff,
		message: logArgs.length === 1 ? String(logArgs[0]) : logArgs.map(String).join(' '),
		args: logArgs,
		timestamp: Date.now(),
		file,
		line,
		col,
		src,
		level,
		stack,
		tableData
	};

	if (_onLogCallback) {
		_onLogCallback(entry);
	} else {
		earlyLogBuffer.push(entry);
	}

	return returnValue;
}

/**
 * gg._ns() - Internal: log with namespace and source file metadata.
 *
 * Called by the ggCallSitesPlugin Vite plugin, which rewrites both bare gg()
 * calls and manual gg.ns() calls to gg._ns({ns, file, line, col}, ...) at
 * build time. This gives each call site a unique namespace plus the source
 * location for open-in-editor support.
 *
 * @param options - { ns: string; file?: string; line?: number; col?: number }
 * @param args - Same arguments as gg()
 * @returns Same as gg() - the first arg, or call-site info if no args
 */
gg._ns = function (
	options: {
		ns: string;
		file?: string;
		line?: number;
		col?: number;
		src?: string;
		level?: LogLevel;
		stack?: string;
	},
	...args: unknown[]
): unknown {
	return ggLog(options, ...args);
};

/**
 * gg._o() - Internal: build options object for gg._ns() without object literal syntax.
 *
 * Used by the vite plugin to transform gg() calls in Svelte template markup,
 * where object literals ({...}) would break Svelte's template parser.
 *
 * In <script> blocks:  gg._ns({ns:'...', file:'...', line:1, col:1}, args)
 * In template markup:  gg._ns(gg._o('...','...',1,1), args)
 */
gg._o = function (
	ns: string,
	file?: string,
	line?: number,
	col?: number,
	src?: string
): { ns: string; file?: string; line?: number; col?: number; src?: string } {
	return { ns, file, line, col, src };
};

gg.disable = isCloudflareWorker() ? () => '' : () => debugFactory.disable();

gg.enable = isCloudflareWorker() ? () => {} : (ns: string) => debugFactory.enable(ns);

/**
 * Clear the persisted gg-enabled state from localStorage.
 * Useful to reset production trigger after testing with ?gg parameter.
 * Page reload required for change to take effect.
 */
gg.clearPersist = () => {
	if (BROWSER) {
		try {
			localStorage.removeItem('gg-enabled');
		} catch {
			// localStorage might not be available
		}
	}
};

// ── Console-like methods ───────────────────────────────────────────────
// Each public method (gg.warn, gg.error, etc.) has a corresponding internal
// method (gg._warn, gg._error, etc.) that accepts call-site metadata from
// the Vite plugin. The public methods use runtime stack-based callpoints
// as a fallback when the plugin isn't installed.

/**
 * Capture a cleaned-up stack trace, stripping internal gg frames.
 * @param skipFrames - Number of internal frames to strip from the top
 */
function captureStack(skipFrames: number): string | undefined {
	let stack = new Error().stack || undefined;
	if (stack) {
		const lines = stack.split('\n');
		stack = lines.slice(skipFrames).join('\n');
	}
	return stack;
}

/**
 * Get stack from an Error arg or capture a fresh one.
 */
function getErrorStack(firstArg: unknown, skipFrames: number): string | undefined {
	if (firstArg instanceof Error && firstArg.stack) {
		return firstArg.stack;
	}
	return captureStack(skipFrames);
}

/**
 * gg.info() - Log at info level.
 *
 * Passthrough: returns the first argument.
 * In Eruda, entries are styled with a blue/info indicator.
 *
 * @example
 * gg.info('System startup complete');
 * const config = gg.info(loadedConfig, 'loaded config');
 */
gg.info = function (this: void, ...args: unknown[]): unknown {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		return args.length ? args[0] : undefined;
	}
	const callpoint = resolveCallpoint(3);
	return ggLog({ ns: callpoint, level: 'info' }, ...args);
};

/**
 * gg._info() - Internal: info with call-site metadata from Vite plugin.
 */
gg._info = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	...args: unknown[]
): unknown {
	return ggLog({ ...options, level: 'info' }, ...args);
};

/**
 * gg.warn() - Log at warning level.
 *
 * Passthrough: returns the first argument.
 * In Eruda, entries are styled with a yellow/warning indicator.
 *
 * @example
 * gg.warn('deprecated API used');
 * const result = gg.warn(computeValue(), 'might be slow');
 */
gg.warn = function (this: void, ...args: unknown[]): unknown {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		return args.length ? args[0] : undefined;
	}
	const callpoint = resolveCallpoint(3);
	return ggLog({ ns: callpoint, level: 'warn' }, ...args);
};

/**
 * gg._warn() - Internal: warn with call-site metadata from Vite plugin.
 */
gg._warn = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	...args: unknown[]
): unknown {
	return ggLog({ ...options, level: 'warn' }, ...args);
};

/**
 * gg.error() - Log at error level.
 *
 * Passthrough: returns the first argument.
 * Captures a stack trace silently — visible in Eruda via a collapsible toggle.
 * If the first argument is an Error object, its .stack is used instead.
 *
 * @example
 * gg.error('connection failed');
 * gg.error(new Error('timeout'));
 * const val = gg.error(response, 'unexpected status');
 */
gg.error = function (this: void, ...args: unknown[]): unknown {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		return args.length ? args[0] : undefined;
	}
	const callpoint = resolveCallpoint(3);
	const stack = getErrorStack(args[0], 4);
	return ggLog({ ns: callpoint, level: 'error', stack }, ...args);
};

/**
 * gg._error() - Internal: error with call-site metadata from Vite plugin.
 */
gg._error = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	...args: unknown[]
): unknown {
	const stack = getErrorStack(args[0], 3);
	return ggLog({ ...options, level: 'error', stack }, ...args);
};

/**
 * gg.assert() - Log only if condition is false.
 *
 * Like console.assert: if the first argument is falsy, logs the remaining
 * arguments at error level. If the condition is truthy, does nothing.
 * Passthrough: always returns the condition value.
 *
 * @example
 * gg.assert(user != null, 'user should exist');
 * gg.assert(list.length > 0, 'list is empty', list);
 */
gg.assert = function (this: void, condition: unknown, ...args: unknown[]): unknown {
	if (!condition) {
		if (!ggConfig.enabled || isCloudflareWorker()) return condition;

		const callpoint = resolveCallpoint(3);
		const stack = captureStack(4);
		const assertArgs = args.length > 0 ? args : ['Assertion failed'];
		ggLog({ ns: callpoint, level: 'error', stack }, ...assertArgs);
	}
	return condition;
};

/**
 * gg._assert() - Internal: assert with call-site metadata from Vite plugin.
 */
gg._assert = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	condition: unknown,
	...args: unknown[]
): unknown {
	if (!condition) {
		if (!ggConfig.enabled || isCloudflareWorker()) return condition;

		const stack = captureStack(3);
		const assertArgs = args.length > 0 ? args : ['Assertion failed'];
		ggLog({ ...options, level: 'error', stack }, ...assertArgs);
	}
	return condition;
};

/**
 * gg.table() - Log tabular data.
 *
 * Formats an array of objects (or an object of objects) as an ASCII table.
 * Passthrough: returns the data argument.
 *
 * @example
 * gg.table([{name: 'Alice', age: 30}, {name: 'Bob', age: 25}]);
 * gg.table({a: {x: 1}, b: {x: 2}});
 */
gg.table = function (this: void, data: unknown, columns?: string[]): unknown {
	if (!ggConfig.enabled || isCloudflareWorker()) return data;

	const callpoint = resolveCallpoint(3);
	const { keys, rows } = formatTable(data, columns);
	ggLog({ ns: callpoint, tableData: { keys, rows } }, '(table)');
	// Also emit a native console.table for proper rendering in browser/Node consoles
	if (columns) {
		console.table(data, columns);
	} else {
		console.table(data);
	}
	return data;
};

/**
 * gg._table() - Internal: table with call-site metadata from Vite plugin.
 */
gg._table = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	data: unknown,
	columns?: string[]
): unknown {
	if (!ggConfig.enabled || isCloudflareWorker()) return data;
	const { keys, rows } = formatTable(data, columns);
	ggLog({ ...options, tableData: { keys, rows } }, '(table)');
	if (columns) {
		console.table(data, columns);
	} else {
		console.table(data);
	}
	return data;
};

// Timer storage for gg.time / gg.timeEnd / gg.timeLog
const timers = new Map<string, number>();

/**
 * gg.time() - Start a named timer.
 *
 * @example
 * gg.time('fetch');
 * const data = await fetchData();
 * gg.timeEnd('fetch'); // logs "+123ms fetch: 456ms"
 */
gg.time = function (this: void, label = 'default'): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	timers.set(label, performance.now());
};

/** gg._time() - Internal: time with call-site metadata from Vite plugin. */
gg._time = function (
	_options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	label = 'default'
): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	timers.set(label, performance.now());
};

/**
 * gg.timeLog() - Log the current elapsed time without stopping the timer.
 *
 * @example
 * gg.time('process');
 * // ... step 1 ...
 * gg.timeLog('process', 'step 1 done');
 * // ... step 2 ...
 * gg.timeEnd('process');
 */
gg.timeLog = function (this: void, label = 'default', ...args: unknown[]): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	const start = timers.get(label);
	if (start === undefined) {
		const callpoint = resolveCallpoint(3);
		ggLog({ ns: callpoint, level: 'warn' }, `Timer '${label}' does not exist`);
		return;
	}
	const elapsed = performance.now() - start;
	const callpoint = resolveCallpoint(3);
	ggLog({ ns: callpoint }, `${label}: ${formatElapsed(elapsed)}`, ...args);
};

/** gg._timeLog() - Internal: timeLog with call-site metadata from Vite plugin. */
gg._timeLog = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	label = 'default',
	...args: unknown[]
): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	const start = timers.get(label);
	if (start === undefined) {
		ggLog({ ...options, level: 'warn' }, `Timer '${label}' does not exist`);
		return;
	}
	const elapsed = performance.now() - start;
	ggLog(options, `${label}: ${formatElapsed(elapsed)}`, ...args);
};

/**
 * gg.timeEnd() - Stop a named timer and log the elapsed time.
 *
 * @example
 * gg.time('fetch');
 * const data = await fetchData();
 * gg.timeEnd('fetch'); // logs "fetch: 456.12ms"
 */
gg.timeEnd = function (this: void, label = 'default'): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	const start = timers.get(label);
	if (start === undefined) {
		const callpoint = resolveCallpoint(3);
		ggLog({ ns: callpoint, level: 'warn' }, `Timer '${label}' does not exist`);
		return;
	}
	const elapsed = performance.now() - start;
	timers.delete(label);
	const callpoint = resolveCallpoint(3);
	ggLog({ ns: callpoint }, `${label}: ${formatElapsed(elapsed)}`);
};

/** gg._timeEnd() - Internal: timeEnd with call-site metadata from Vite plugin. */
gg._timeEnd = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	label = 'default'
): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	const start = timers.get(label);
	if (start === undefined) {
		ggLog({ ...options, level: 'warn' }, `Timer '${label}' does not exist`);
		return;
	}
	const elapsed = performance.now() - start;
	timers.delete(label);
	ggLog(options, `${label}: ${formatElapsed(elapsed)}`);
};

/**
 * gg.trace() - Log with a stack trace.
 *
 * Like console.trace: logs the arguments plus a full stack trace.
 * Passthrough: returns the first argument.
 *
 * @example
 * gg.trace('how did we get here?');
 * const val = gg.trace(result, 'call path');
 */
gg.trace = function (this: void, ...args: unknown[]): unknown {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		return args.length ? args[0] : undefined;
	}
	const callpoint = resolveCallpoint(3);
	const stack = captureStack(4);
	const traceArgs = args.length > 0 ? args : ['Trace'];
	return ggLog({ ns: callpoint, stack }, ...traceArgs);
};

/**
 * gg._trace() - Internal: trace with call-site metadata from Vite plugin.
 */
gg._trace = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	...args: unknown[]
): unknown {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		return args.length ? args[0] : undefined;
	}
	const stack = captureStack(3);
	const traceArgs = args.length > 0 ? args : ['Trace'];
	return ggLog({ ...options, stack }, ...traceArgs);
};

/**
 * Format elapsed time with appropriate precision.
 * < 1s → "123.45ms", >= 1s → "1.23s", >= 60s → "1m 2.3s"
 */
function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(2)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = (ms % 60000) / 1000;
	return `${minutes}m ${seconds.toFixed(1)}s`;
}

/** Result from formatTable: structured data for Eruda HTML table */
interface TableResult {
	keys: string[];
	rows: Array<Record<string, unknown>>;
}

/**
 * Normalize data into structured keys + rows for table rendering.
 * Used by both Eruda (HTML table) and console.table() delegation.
 * Supports arrays of objects, arrays of primitives, and objects of objects.
 */
function formatTable(data: unknown, columns?: string[]): TableResult {
	if (data === null || data === undefined || typeof data !== 'object') {
		return { keys: [], rows: [] };
	}

	// Normalize to rows: [{key, ...values}]
	let rows: Array<Record<string, unknown>>;
	let allKeys: string[];

	if (Array.isArray(data)) {
		if (data.length === 0) return { keys: [], rows: [] };

		// Array of primitives
		if (typeof data[0] !== 'object' || data[0] === null) {
			allKeys = ['(index)', 'Value'];
			rows = data.map((v, i) => ({ '(index)': i, Value: v }));
		} else {
			// Array of objects
			const keySet = new Set<string>();
			keySet.add('(index)');
			for (const item of data) {
				if (item && typeof item === 'object') {
					Object.keys(item as Record<string, unknown>).forEach((k) => keySet.add(k));
				}
			}
			allKeys = Array.from(keySet);
			rows = data.map((item, i) => ({
				'(index)': i,
				...((item && typeof item === 'object' ? item : { Value: item }) as Record<string, unknown>)
			}));
		}
	} else {
		// Object of objects/values
		const entries = Object.entries(data as Record<string, unknown>);
		if (entries.length === 0) return { keys: [], rows: [] };

		const keySet = new Set<string>();
		keySet.add('(index)');
		for (const [, val] of entries) {
			if (val && typeof val === 'object' && !Array.isArray(val)) {
				Object.keys(val as Record<string, unknown>).forEach((k) => keySet.add(k));
			} else {
				keySet.add('Value');
			}
		}
		allKeys = Array.from(keySet);
		rows = entries.map(([key, val]) => ({
			'(index)': key,
			...(val && typeof val === 'object' && !Array.isArray(val)
				? (val as Record<string, unknown>)
				: { Value: val })
		}));
	}

	// Apply column filter
	if (columns && columns.length > 0) {
		allKeys = ['(index)', ...columns.filter((c) => allKeys.includes(c))];
	}

	return { keys: allKeys, rows };
}

/**
 * ANSI Color Helpers for gg()
 *
 * Create reusable color schemes with foreground (fg) and background (bg) colors.
 * Works in both native console and Eruda plugin.
 *
 * @example
 * // Method chaining (order doesn't matter)
 * gg(fg('white').bg('red')`Critical error!`);
 * gg(bg('green').fg('white')`Success!`);
 *
 * @example
 * // Define color schemes once, reuse everywhere
 * const input = fg('blue').bg('yellow');
 * const transcript = bg('green').fg('white');
 * const error = fg('white').bg('red');
 *
 * gg(input`User said: hello`);
 * gg(transcript`AI responded: hi`);
 * gg(error`Something broke!`);
 *
 * @example
 * // Mix colored and normal text inline
 * gg(fg('red')`Error: ` + bg('yellow')`warning` + ' normal text');
 *
 * @example
 * // Custom colors (hex, rgb, or named)
 * gg(fg('#ff6347').bg('#98fb98')`Custom colors`);
 *
 * @example
 * // Just foreground or background
 * gg(fg('cyan')`Cyan text`);
 * gg(bg('magenta')`Magenta background`);
 */

type ColorTagFunction = (strings: TemplateStringsArray, ...values: unknown[]) => string;

interface ChainableColorFn extends ColorTagFunction {
	// Method chaining: fg('red').bg('green').bold()
	fg: (color: string) => ChainableColorFn;
	bg: (color: string) => ChainableColorFn;
	bold: () => ChainableColorFn;
	italic: () => ChainableColorFn;
	underline: () => ChainableColorFn;
	dim: () => ChainableColorFn;
}

/**
 * Parse color string to RGB values
 * Accepts: named colors, hex (#rgb, #rrggbb), rgb(r,g,b), rgba(r,g,b,a)
 */
function parseColor(color: string): { r: number; g: number; b: number } | null {
	// Named colors map (basic ANSI colors + common web colors)
	const namedColors: Record<string, string> = {
		black: '#000000',
		red: '#ff0000',
		green: '#00ff00',
		yellow: '#ffff00',
		blue: '#0000ff',
		magenta: '#ff00ff',
		cyan: '#00ffff',
		white: '#ffffff',
		// Bright variants
		brightBlack: '#808080',
		brightRed: '#ff6666',
		brightGreen: '#66ff66',
		brightYellow: '#ffff66',
		brightBlue: '#6666ff',
		brightMagenta: '#ff66ff',
		brightCyan: '#66ffff',
		brightWhite: '#ffffff',
		// Common aliases
		gray: '#808080',
		grey: '#808080',
		orange: '#ffa500',
		purple: '#800080',
		pink: '#ffc0cb'
	};

	// Check named colors first
	const normalized = color.toLowerCase().trim();
	if (namedColors[normalized]) {
		color = namedColors[normalized];
	}

	// Parse hex color
	const hexMatch = color.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
	if (hexMatch) {
		return {
			r: parseInt(hexMatch[1], 16),
			g: parseInt(hexMatch[2], 16),
			b: parseInt(hexMatch[3], 16)
		};
	}

	// Parse short hex (#rgb)
	const shortHexMatch = color.match(/^#?([a-f\d])([a-f\d])([a-f\d])$/i);
	if (shortHexMatch) {
		return {
			r: parseInt(shortHexMatch[1] + shortHexMatch[1], 16),
			g: parseInt(shortHexMatch[2] + shortHexMatch[2], 16),
			b: parseInt(shortHexMatch[3] + shortHexMatch[3], 16)
		};
	}

	// Parse rgb(r,g,b) or rgba(r,g,b,a)
	const rgbMatch = color.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
	if (rgbMatch) {
		return {
			r: parseInt(rgbMatch[1]),
			g: parseInt(rgbMatch[2]),
			b: parseInt(rgbMatch[3])
		};
	}

	return null;
}

/**
 * ANSI style codes for text formatting
 */
const STYLE_CODES = {
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	italic: '\x1b[3m',
	underline: '\x1b[4m'
} as const;

/**
 * Internal helper to create chainable color function with method chaining
 */
function createColorFunction(
	fgCode: string = '',
	bgCode: string = '',
	styleCode: string = ''
): ChainableColorFn {
	const tagFn = function (strings: TemplateStringsArray, ...values: unknown[]): string {
		const text = strings.reduce(
			(acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''),
			''
		);
		return fgCode + bgCode + styleCode + text + '\x1b[0m';
	};

	// Add method chaining
	tagFn.fg = (color: string) => {
		const rgb = parseColor(color);
		const newFgCode = rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m` : '';
		return createColorFunction(newFgCode, bgCode, styleCode);
	};

	tagFn.bg = (color: string) => {
		const rgb = parseColor(color);
		const newBgCode = rgb ? `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m` : '';
		return createColorFunction(fgCode, newBgCode, styleCode);
	};

	tagFn.bold = () => {
		return createColorFunction(fgCode, bgCode, styleCode + STYLE_CODES.bold);
	};

	tagFn.italic = () => {
		return createColorFunction(fgCode, bgCode, styleCode + STYLE_CODES.italic);
	};

	tagFn.underline = () => {
		return createColorFunction(fgCode, bgCode, styleCode + STYLE_CODES.underline);
	};

	tagFn.dim = () => {
		return createColorFunction(fgCode, bgCode, styleCode + STYLE_CODES.dim);
	};

	return tagFn as ChainableColorFn;
}

/**
 * Foreground (text) color helper
 * Can be used directly or chained with .bg()
 *
 * @param color - Named color, hex (#rrggbb), or rgb(r,g,b)
 * @example
 * gg(fg('red')`Error`);
 * gg(fg('white').bg('red')`Critical!`);
 */
export function fg(color: string): ChainableColorFn {
	const rgb = parseColor(color);
	const fgCode = rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m` : '';
	return createColorFunction(fgCode, '');
}

/**
 * Background color helper
 * Can be used directly or chained with .fg()
 *
 * @param color - Named color, hex (#rrggbb), or rgb(r,g,b)
 * @example
 * gg(bg('yellow')`Warning`);
 * gg(bg('green').fg('white')`Success!`);
 */
export function bg(color: string): ChainableColorFn {
	const rgb = parseColor(color);
	const bgCode = rgb ? `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m` : '';
	return createColorFunction('', bgCode);
}

/**
 * Bold text style
 * Can be used directly or chained with colors
 *
 * @example
 * gg(bold()`Important text`);
 * gg(bold().fg('red')`Bold red error`);
 * gg(fg('green').bold()`Bold green success`);
 */
export function bold(): ChainableColorFn {
	return createColorFunction('', '', STYLE_CODES.bold);
}

/**
 * Italic text style
 * Can be used directly or chained with colors
 *
 * @example
 * gg(italic()`Emphasized text`);
 * gg(italic().fg('blue')`Italic blue`);
 */
export function italic(): ChainableColorFn {
	return createColorFunction('', '', STYLE_CODES.italic);
}

/**
 * Underline text style
 * Can be used directly or chained with colors
 *
 * @example
 * gg(underline()`Underlined text`);
 * gg(underline().fg('cyan')`Underlined cyan`);
 */
export function underline(): ChainableColorFn {
	return createColorFunction('', '', STYLE_CODES.underline);
}

/**
 * Dim text style (faint/dimmed appearance)
 * Can be used directly or chained with colors
 *
 * @example
 * gg(dim()`Less important text`);
 * gg(dim().fg('white')`Dimmed white`);
 */
export function dim(): ChainableColorFn {
	return createColorFunction('', '', STYLE_CODES.dim);
}

/**
 * Hook for capturing gg() output (used by Eruda plugin)
 * Set this to a callback function to receive log entries
 */
// Buffer for capturing early logs before Eruda initializes
const earlyLogBuffer: CapturedEntry[] = [];
let _onLogCallback: OnLogCallback | null = null;

// Proxy property that replays buffered logs when hook is registered
Object.defineProperty(gg, '_onLog', {
	get() {
		return _onLogCallback;
	},
	set(callback: OnLogCallback | null) {
		_onLogCallback = callback;
		// Replay buffered logs when callback is first registered
		if (callback && earlyLogBuffer.length > 0) {
			earlyLogBuffer.forEach((entry) => callback(entry));
			earlyLogBuffer.length = 0; // Clear buffer after replay
		}
	}
});

// Namespace for adding properties to the gg function
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace gg {
	export let _onLog: OnLogCallback | null;
	export let ns: (nsLabel: string, ...args: unknown[]) => unknown;
	export let _ns: (
		options: {
			ns: string;
			file?: string;
			line?: number;
			col?: number;
			src?: string;
			level?: LogLevel;
			stack?: string;
		},
		...args: unknown[]
	) => unknown;
	export let _o: (
		ns: string,
		file?: string,
		line?: number,
		col?: number,
		src?: string
	) => { ns: string; file?: string; line?: number; col?: number; src?: string };

	// Console-like methods (public API)
	export let info: (...args: unknown[]) => unknown;
	export let warn: (...args: unknown[]) => unknown;
	export let error: (...args: unknown[]) => unknown;
	export let assert: (condition: unknown, ...args: unknown[]) => unknown;
	export let table: (data: unknown, columns?: string[]) => unknown;
	export let time: (label?: string) => void;
	export let timeLog: (label?: string, ...args: unknown[]) => void;
	export let timeEnd: (label?: string) => void;
	export let trace: (...args: unknown[]) => unknown;

	// Internal plugin-rewrite targets (same as above but with call-site metadata)
	export let _info: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		...args: unknown[]
	) => unknown;
	export let _warn: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		...args: unknown[]
	) => unknown;
	export let _error: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		...args: unknown[]
	) => unknown;
	export let _assert: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		condition: unknown,
		...args: unknown[]
	) => unknown;
	export let _table: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		data: unknown,
		columns?: string[]
	) => unknown;
	export let _trace: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		...args: unknown[]
	) => unknown;
	export let _time: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		label?: string
	) => void;
	export let _timeLog: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		label?: string,
		...args: unknown[]
	) => void;
	export let _timeEnd: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		label?: string
	) => void;
}

// Track if diagnostics have already run to prevent double execution
let diagnosticsRan = false;

/**
 * Run gg diagnostics and log configuration status
 * Can be called immediately or delayed (e.g., after Eruda loads)
 */
export async function runGgDiagnostics() {
	if (!ggConfig.showHints || isCloudflareWorker() || diagnosticsRan) return;
	diagnosticsRan = true;

	// Ensure server modules (dotenv) and debug factory are loaded before diagnostics
	await serverModulesReady;
	await debugReady;

	// Create test debugger for server-side enabled check
	const ggLogTest = debugFactory('gg:TEST');

	let ggMessage = '\n';
	const message = (s: string) => (ggMessage += `${s}\n`);
	const checkbox = (test: boolean) => (test ? '✅' : '❌');
	const makeHint = (test: boolean, ifTrue: string, ifFalse = '') => (test ? ifTrue : ifFalse);

	console.log(`Loaded gg module. Checking configuration...`);

	const configOk = BROWSER ? ggConfig.enabled : ggConfig.enabled && ggLogTest.enabled;

	if (configOk) {
		message(`No problems detected:`);
		if (BROWSER) {
			message(
				`ℹ️ gg messages appear in the Eruda GG panel. Use Settings > Native Console to also show in browser console.`
			);
		}
	} else {
		message(`Problems detected; fix all ❌:`);
	}

	let enableHint = '';
	if (!ggConfig.enabled) {
		if (DEV) {
			enableHint = ' (Check GG_ENABLED env variable)';
		} else if (BROWSER) {
			enableHint = ' (Add ?gg to URL or set localStorage["gg-enabled"]="true")';
		}
	}
	message(`${checkbox(ggConfig.enabled)} gg enabled: ${ggConfig.enabled}${enableHint}`);

	if (!BROWSER) {
		// Server-side: check DEBUG env var (the only output path on the server)
		const hint = makeHint(!ggLogTest.enabled, ' (Try `DEBUG=gg:* npm run dev`)');
		if (dotenvModule) {
			dotenvModule.config();
		}
		message(`${checkbox(ggLogTest.enabled)} DEBUG env variable: ${process?.env?.DEBUG}${hint}`);
	}

	// Optional plugin diagnostics
	message(
		makeHint(
			_ggCallSitesPlugin,
			`✅ gg-call-sites vite plugin detected! Call-site namespaces and open-in-editor links baked in at build time.`,
			`⚠️ gg-call-sites vite plugin not detected. Add ggCallSitesPlugin() to vite.config.ts for file:line call-site namespaces and open-in-editor links. Without plugin, using word-tuple names (e.g. calm-fox) as call-site identifiers.`
		)
	);

	if (BROWSER && DEV) {
		const { status } = await fetch('/__open-in-editor?file=+');
		message(
			makeHint(
				status === 222,
				`✅ (optional) open-in-editor vite plugin detected! (status code: ${status}) Clickable links open source files in editor.`,
				`⚠️ (optional) open-in-editor vite plugin not detected. (status code: ${status}) Add openInEditorPlugin() to vite.config.ts for clickable links that open source files in editor`
			)
		);
	}

	console.log(ggMessage);
	resetNamespaceWidth();
}

// Run diagnostics immediately on module load ONLY in Node.js environments
// In browser, the Eruda loader (if configured) will call runGgDiagnostics()
// after Eruda is ready. If Eruda is not configured, diagnostics won't run
// in browser (user must manually check console or call runGgDiagnostics()).
if (ggConfig.showHints && !isCloudflareWorker() && !BROWSER) {
	runGgDiagnostics();
}
