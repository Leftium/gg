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
type HttpModule = typeof import('http');
type AddressInfo = import('net').AddressInfo;

// Lazy-load Node.js modules to avoid top-level await (Safari compatibility).
// The imports start immediately but don't block module evaluation.
let httpModule: HttpModule | null = null;

function loadServerModules(): Promise<void> {
	if (isCloudflareWorker() || BROWSER) return Promise.resolve();

	return (async () => {
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

/**
 * Log a value and return a chainable wrapper.
 *
 * Chain modifiers to configure the log entry:
 * - `.ns('label')` — set a custom namespace
 * - `.warn()` / `.error()` / `.info()` — set log level
 * - `.trace()` — include stack trace
 * - `.table()` — format as ASCII table
 * - `.v` — flush immediately and return the passthrough value
 *
 * Without `.v`, the log auto-flushes on the next microtask.
 *
 * @example
 * gg(value)                          // log with auto namespace
 * gg(value).ns('label').warn()       // log with namespace + warn level
 * const x = gg(value).v              // passthrough
 * const x = gg(value).ns('foo').v    // passthrough with namespace
 */
export function gg<T>(arg: T, ...args: unknown[]): GgChain<T>;
export function gg(...args: unknown[]): GgChain<unknown> {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		// Return a no-op chain that skips logging
		return new GgChain(args[0], args, { ns: '' }, true);
	}

	// Without the call-sites plugin, use cheap stack hash → deterministic word tuple.
	// When the plugin IS installed, all gg() calls are rewritten to gg._ns() at build time,
	// so this code path only runs for un-transformed calls (i.e. plugin not installed).
	// Same call site always produces the same word pair (e.g. "calm-fox").
	// depth=2: skip "Error" header [0] and gg() frame [1]
	const callpoint = resolveCallpoint(2);
	return new GgChain(args[0], args, { ns: callpoint });
}

/**
 * gg.here() - Return call-site info for open-in-editor.
 *
 * Replaces the old no-arg gg() overload. Returns an object with the
 * file name, function name, and URL for opening the source in an editor.
 *
 * @example
 * <OpenInEditorLink gg={gg.here()} />
 */
gg.here = function (): { fileName: string; functionName: string; url: string } {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		return { fileName: '', functionName: '', url: '' };
	}
	const callpoint = resolveCallpoint(3);
	const namespace = `gg:${callpoint}`;
	// Log the call-site info
	const ggLogFunction =
		namespaceToLogFunction.get(namespace) ||
		namespaceToLogFunction.set(namespace, createGgDebugger(namespace)).get(namespace)!;
	ggLogFunction(`    📝 ${callpoint}`);

	return {
		fileName: callpoint,
		functionName: callpoint.includes('@') ? callpoint.split('@').pop() || '' : '',
		url: ''
	};
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
 * Resolve template variables in a namespace label using metadata from the plugin.
 *
 * The Vite plugin bakes the auto-generated callpoint into options.ns at build time
 * (e.g. "routes/+page.svelte@handleClick"). This function extracts components from
 * that callpoint and substitutes template variables:
 *
 *   $NS   - the full auto-generated callpoint (or runtime word-tuple fallback)
 *   $FN   - the function name portion (after @)
 *   $FILE - the file path portion (before @)
 *   $LINE - the line number
 *   $COL  - the column number
 */
function resolveNsTemplateVars(label: string, options: LogOptions): string {
	if (!label.includes('$')) return label;

	const ns = options.ns || '';
	// $NS: use the full auto-generated callpoint. If no plugin, fall back to runtime stack hash.
	if (label.includes('$NS')) {
		const callpoint = ns || resolveCallpoint(4);
		label = label.replace(/\$NS/g, callpoint);
	}
	// $FN: extract function name from "file@fn" format
	if (label.includes('$FN')) {
		const fn = ns.includes('@') ? ns.split('@').pop() || '' : '';
		label = label.replace(/\$FN/g, fn);
	}
	// $FILE: extract file path from "file@fn" format
	if (label.includes('$FILE')) {
		const file = ns.includes('@') ? ns.split('@')[0] : ns;
		label = label.replace(/\$FILE/g, file);
	}
	// $LINE / $COL: from plugin metadata
	if (label.includes('$LINE')) {
		label = label.replace(/\$LINE/g, String(options.line ?? ''));
	}
	if (label.includes('$COL')) {
		label = label.replace(/\$COL/g, String(options.col ?? ''));
	}
	return label;
}

/**
 * Chainable wrapper returned by gg(). Collects modifiers (.ns(), .warn(), etc.)
 * and auto-flushes the log on the next microtask. Use `.v` to flush immediately
 * and get the passthrough value.
 *
 * @example
 * gg(value)                          // logs on microtask
 * gg(value).ns('label').warn()       // logs with namespace + warn level
 * const x = gg(value).v              // logs immediately, returns value
 * const x = gg(value).ns('foo').v    // logs with namespace, returns value
 */
export class GgChain<T> {
	#value: T;
	#args: unknown[];
	#options: LogOptions;
	#flushed = false;
	#disabled: boolean;

	constructor(value: T, args: unknown[], options: LogOptions, disabled = false) {
		this.#value = value;
		this.#args = args;
		this.#options = options;
		this.#disabled = disabled;
		if (!disabled) {
			// Auto-flush on microtask if not flushed synchronously by .v or another trigger
			queueMicrotask(() => this.#flush());
		}
	}

	/** Set a custom namespace for this log entry.
	 *
	 * Supports template variables (resolved from plugin-provided metadata):
	 *   $NS   - auto-generated callpoint (file@fn with plugin, word-tuple without)
	 *   $FN   - enclosing function name (extracted from $NS)
	 *   $FILE - short file path (extracted from $NS)
	 *   $LINE - line number
	 *   $COL  - column number
	 */
	ns(label: string): GgChain<T> {
		this.#options.ns = resolveNsTemplateVars(label, this.#options);
		return this;
	}

	/** Set log level to info (blue indicator). */
	info(): GgChain<T> {
		this.#options.level = 'info';
		return this;
	}

	/** Set log level to warn (yellow indicator). */
	warn(): GgChain<T> {
		this.#options.level = 'warn';
		return this;
	}

	/** Set log level to error (red indicator, captures stack trace). */
	error(): GgChain<T> {
		this.#options.level = 'error';
		this.#options.stack = getErrorStack(this.#args[0], 3);
		return this;
	}

	/** Include a full stack trace with this log entry. */
	trace(): GgChain<T> {
		this.#options.stack = captureStack(3);
		return this;
	}

	/** Format the log output as an ASCII table. */
	table(columns?: string[]): GgChain<T> {
		const { keys, rows } = formatTable(this.#args[0], columns);
		this.#options.tableData = { keys, rows };
		// Override args to show '(table)' label, matching original gg.table() behavior
		this.#args = ['(table)'];
		// Also emit native console.table
		if (columns) {
			console.table(this.#value, columns);
		} else {
			console.table(this.#value);
		}
		return this;
	}

	/** Flush the log immediately and return the passthrough value. */
	get v(): T {
		this.#flush();
		return this.#value;
	}

	#flush() {
		if (this.#flushed) return;
		this.#flushed = true;
		ggLog(this.#options, ...this.#args);
	}
}

/**
 * Core logging function shared by all gg methods.
 *
 * Handles namespace resolution, debug output, capture hook, and return value.
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
	const logArgs: unknown[] = args.length === 0 ? ['(no args)'] : [...args];

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
}

/**
 * gg._ns() - Internal: log with namespace and source file metadata.
 *
 * Called by the ggCallSitesPlugin Vite plugin, which rewrites bare gg()
 * calls to gg._ns({ns, file, line, col, src}, ...) at build time.
 * This gives each call site a unique namespace plus the source
 * location for open-in-editor support.
 *
 * Returns a GgChain for chaining modifiers (.ns(), .warn(), etc.)
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
): GgChain<unknown> {
	const disabled = !ggConfig.enabled || isCloudflareWorker();
	return new GgChain(args[0], args, options, disabled);
};

/**
 * gg._here() - Internal: call-site info with source metadata from Vite plugin.
 *
 * Called by the ggCallSitesPlugin when it rewrites gg.here() calls.
 */
gg._here = function (options: { ns: string; file?: string; line?: number; col?: number }): {
	fileName: string;
	functionName: string;
	url: string;
} {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		return { fileName: '', functionName: '', url: '' };
	}
	const { ns: nsLabel, file, line, col } = options;
	const namespace = `gg:${nsLabel}`;
	const ggLogFunction =
		namespaceToLogFunction.get(namespace) ||
		namespaceToLogFunction.set(namespace, createGgDebugger(namespace)).get(namespace)!;
	ggLogFunction(`    📝 ${nsLabel}`);

	const fileName = file ? file.replace(srcRootRegex, '') : nsLabel;
	const functionName = nsLabel.includes('@') ? nsLabel.split('@').pop() || '' : '';
	const url = file ? openInEditorUrl(file, line, col) : '';
	return { fileName, functionName, url };
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

// Timer storage for gg.time / gg.timeEnd / gg.timeLog
// Maps timer label → { start: number, ns?: string, options?: LogOptions }
const timers = new Map<string, { start: number; ns?: string; options?: LogOptions }>();

/**
 * Chainable wrapper returned by gg.time(). Only supports .ns() for setting
 * the namespace for the entire timer group (inherited by timeLog/timeEnd).
 *
 * @example
 * gg.time('fetch').ns('api-pipeline')
 * gg.time('fetch').ns('$FN:timers')    // template vars work too
 */
export class GgTimerChain {
	#label: string;
	#options: LogOptions;

	constructor(label: string, options: LogOptions) {
		this.#label = label;
		this.#options = options;
	}

	/** Set a custom namespace for this timer group.
	 * Supports the same template variables as GgChain.ns().
	 */
	ns(label: string): GgTimerChain {
		const resolved = resolveNsTemplateVars(label, this.#options);
		const timer = timers.get(this.#label);
		if (timer) timer.ns = resolved;
		return this;
	}
}

/**
 * gg.time() - Start a named timer. Returns a GgTimerChain for optional .ns() chaining.
 *
 * @param label - Timer label (default: 'default')
 *
 * @example
 * gg.time('fetch')                     // basic timer
 * gg.time('fetch').ns('api-pipeline')  // with namespace (inherited by timeLog/timeEnd)
 * gg.time('fetch').ns('$FN:timers')    // with template variable (plugin)
 */
gg.time = function (this: void, label = 'default'): GgTimerChain {
	const options: LogOptions = { ns: resolveCallpoint(3) };
	if (ggConfig.enabled && !isCloudflareWorker()) {
		timers.set(label, { start: performance.now(), options });
	}
	return new GgTimerChain(label, options);
};

/** gg._time() - Internal: time with call-site metadata from Vite plugin. */
gg._time = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	label = 'default'
): GgTimerChain {
	if (ggConfig.enabled && !isCloudflareWorker()) {
		timers.set(label, { start: performance.now(), options });
	}
	return new GgTimerChain(label, options);
};

/**
 * gg.timeLog() - Log the current elapsed time without stopping the timer.
 *
 * Inherits the namespace set by gg.time().ns() for this timer label.
 *
 * @example
 * gg.time('process').ns('my-namespace');
 * // ... step 1 ...
 * gg.timeLog('process', 'step 1 done');
 * // ... step 2 ...
 * gg.timeEnd('process');
 */
gg.timeLog = function (this: void, label = 'default', ...args: unknown[]): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	const timer = timers.get(label);
	if (timer === undefined) {
		const callpoint = resolveCallpoint(3);
		ggLog({ ns: callpoint, level: 'warn' }, `Timer '${label}' does not exist`);
		return;
	}
	const elapsed = performance.now() - timer.start;
	const ns = timer.ns ?? timer.options?.ns ?? resolveCallpoint(3);
	ggLog({ ...timer.options, ns }, `${label}: ${formatElapsed(elapsed)}`, ...args);
};

/** gg._timeLog() - Internal: timeLog with call-site metadata from Vite plugin. */
gg._timeLog = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	label = 'default',
	...args: unknown[]
): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	const timer = timers.get(label);
	if (timer === undefined) {
		ggLog({ ...options, level: 'warn' }, `Timer '${label}' does not exist`);
		return;
	}
	const elapsed = performance.now() - timer.start;
	const ns = timer.ns ?? timer.options?.ns ?? options.ns;
	ggLog({ ...options, ns }, `${label}: ${formatElapsed(elapsed)}`, ...args);
};

/**
 * gg.timeEnd() - Stop a named timer and log the elapsed time.
 *
 * Inherits the namespace set by gg.time().ns() for this timer label.
 *
 * @example
 * gg.time('fetch').ns('api-pipeline');
 * const data = await fetchData();
 * gg.timeEnd('fetch'); // logs under 'api-pipeline' namespace
 */
gg.timeEnd = function (this: void, label = 'default'): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	const timer = timers.get(label);
	if (timer === undefined) {
		const callpoint = resolveCallpoint(3);
		ggLog({ ns: callpoint, level: 'warn' }, `Timer '${label}' does not exist`);
		return;
	}
	const elapsed = performance.now() - timer.start;
	timers.delete(label);
	const ns = timer.ns ?? timer.options?.ns ?? resolveCallpoint(3);
	ggLog({ ...timer.options, ns }, `${label}: ${formatElapsed(elapsed)}`);
};

/** gg._timeEnd() - Internal: timeEnd with call-site metadata from Vite plugin. */
gg._timeEnd = function (
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	label = 'default'
): void {
	if (!ggConfig.enabled || isCloudflareWorker()) return;
	const timer = timers.get(label);
	if (timer === undefined) {
		ggLog({ ...options, level: 'warn' }, `Timer '${label}' does not exist`);
		return;
	}
	const elapsed = performance.now() - timer.start;
	timers.delete(label);
	const ns = timer.ns ?? timer.options?.ns ?? options.ns;
	ggLog({ ...options, ns }, `${label}: ${formatElapsed(elapsed)}`);
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

	// Internal plugin-rewrite target
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
	) => GgChain<unknown>;

	// Internal: build options object without braces (for Svelte template markup)
	export let _o: (
		ns: string,
		file?: string,
		line?: number,
		col?: number,
		src?: string
	) => { ns: string; file?: string; line?: number; col?: number; src?: string };

	// Introspection
	export let here: () => { fileName: string; functionName: string; url: string };
	export let _here: (options: { ns: string; file?: string; line?: number; col?: number }) => {
		fileName: string;
		functionName: string;
		url: string;
	};

	// Control methods
	export let enable: (ns: string) => void;
	export let disable: () => string;
	export let clearPersist: () => void;

	// Timer methods
	export let time: (label?: string) => GgTimerChain;
	export let timeLog: (label?: string, ...args: unknown[]) => void;
	export let timeEnd: (label?: string) => void;

	// Internal plugin-rewrite targets for timers
	export let _time: (
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		label?: string
	) => GgTimerChain;
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

	// Ensure server modules and debug factory are loaded before diagnostics
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
		const hint = makeHint(
			!ggLogTest.enabled,
			' (Try `DEBUG=gg:* npm run dev` or use --env-file=.env)'
		);
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
