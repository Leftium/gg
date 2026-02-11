import debugFactory from './debug.js';
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
function createGgDebugger(namespace: string): debug.Debugger {
	const dbg = debugFactory(namespace);

	// Store the original formatArgs (if it exists)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const originalFormatArgs = (dbg as any).formatArgs;

	// Override formatArgs to add padding to the namespace display
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(dbg as any).formatArgs = function (this: any, args: any[]) {
		// Call original formatArgs first
		if (originalFormatArgs) {
			originalFormatArgs.call(this, args);
		}

		// Extract the callpoint from namespace (strip 'gg:' prefix and any URL suffix)
		const nsMatch = this.namespace.match(/^gg:([^h]+?)(?:http|$)/);
		const callpoint = nsMatch ? nsMatch[1] : this.namespace.replace(/^gg:/, '');
		const paddedCallpoint = callpoint.padEnd(maxCallpointLength, ' ');

		// Replace the namespace in the formatted string with padded version
		if (typeof args[0] === 'string') {
			args[0] = args[0].replace(this.namespace, `gg:${paddedCallpoint}`);
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

// Try to load Node.js modules if not in CloudFlare Workers
let dotenvModule: DotenvModule | null = null;
let httpModule: HttpModule | null = null;

if (!isCloudflareWorker() && !BROWSER) {
	try {
		dotenvModule = await import('dotenv');
	} catch {
		httpModule = await import('http');
		// Failed to import Node.js modules
		console.warn('gg: Node.js modules not available');
	}
}

function findAvailablePort(startingPort: number): Promise<number> {
	if (!httpModule) return Promise.resolve(startingPort);

	return new Promise((resolve) => {
		const server = httpModule.createServer();
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
			// Node.js environment
			const startingPort = Number(process?.env?.PORT) || 5173; // Default to Vite's default port

			findAvailablePort(startingPort).then((actualPort) => {
				resolve(actualPort);
			});
		}
	});
}

const port = await getServerPort();

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
const namespaceToLogFunction = new Map<string, debug.Debugger>();
let maxCallpointLength = 0;

// Cache: raw stack line → word tuple (avoids re-hashing the same call site)
const stackLineCache = new Map<string, string>();

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
	const rawStack = new Error().stack || '';
	// Stack line [2]: skip "Error" header [0] and gg() frame [1]
	const callerLine = rawStack.split('\n')[2] || rawStack;

	// Strip line:col numbers so all gg() calls within the same function
	// hash to the same word tuple. In minified builds, multiple gg() calls
	// in one function differ only by column offset — we want them grouped.
	// Chrome: "at handleClick (chunk-abc.js:1:45892)" → "at handleClick (chunk-abc.js)"
	// Firefox: "handleClick@https://...:1:45892" → "handleClick@https://..."
	const callerKey = callerLine.replace(/:\d+:\d+\)?$/, '').trim();

	const callpoint = stackLineCache.get(callerKey) ?? toWordTuple(callerKey);
	if (!stackLineCache.has(callerKey)) {
		stackLineCache.set(callerKey, callpoint);
	}

	if (callpoint.length < 80 && callpoint.length > maxCallpointLength) {
		maxCallpointLength = callpoint.length;
	}

	const namespace = `gg:${callpoint}`;

	const ggLogFunction =
		namespaceToLogFunction.get(namespace) ||
		namespaceToLogFunction.set(namespace, createGgDebugger(namespace)).get(namespace)!;

	// Prepare args for logging
	let logArgs: unknown[];
	let returnValue: unknown;

	if (!args.length) {
		// No arguments: return stub call-site info (no open-in-editor without plugin)
		logArgs = [`    📝 ${callpoint} (install gg-call-sites-plugin for editor links)`];
		returnValue = {
			fileName: callpoint,
			functionName: '',
			url: ''
		};
	} else if (args.length === 1) {
		logArgs = [args[0]];
		returnValue = args[0];
	} else {
		logArgs = [args[0], ...args.slice(1)];
		returnValue = args[0];
	}

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
		diff: ggLogFunction.diff || 0, // Millisecond diff from debug library
		message: logArgs.length === 1 ? String(logArgs[0]) : logArgs.map(String).join(' '),
		args: logArgs, // Keep raw args for object inspection
		timestamp: Date.now()
	};

	if (_onLogCallback) {
		_onLogCallback(entry);
	} else {
		// Buffer early logs before Eruda initializes
		earlyLogBuffer.push(entry);
	}

	return returnValue;
}

/**
 * gg.ns() - Log with an explicit namespace (callpoint label).
 *
 * Users call gg.ns() directly to set a meaningful label that survives
 * across builds. For the internal plugin-generated version with file
 * metadata, see gg._ns().
 *
 * @param nsLabel - The namespace label (appears as gg:<nsLabel> in output)
 * @param args - Same arguments as gg()
 * @returns Same as gg() - the first arg, or call-site info if no args
 *
 * @example
 * gg.ns("auth", "login failed")   // logs under namespace "gg:auth"
 * gg.ns("cart", item, quantity)    // logs under namespace "gg:cart"
 */
gg.ns = function (nsLabel: string, ...args: unknown[]): unknown {
	return gg._ns({ ns: nsLabel }, ...args);
};

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
	options: { ns: string; file?: string; line?: number; col?: number; src?: string },
	...args: unknown[]
): unknown {
	const { ns: nsLabel, file, line, col, src } = options;

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
		diff: ggLogFunction.diff || 0,
		message: logArgs.length === 1 ? String(logArgs[0]) : logArgs.map(String).join(' '),
		args: logArgs,
		timestamp: Date.now(),
		file,
		line,
		col,
		src
	};

	if (_onLogCallback) {
		_onLogCallback(entry);
	} else {
		earlyLogBuffer.push(entry);
	}

	return returnValue;
};

gg.disable = isCloudflareWorker() ? () => {} : debugFactory.disable;

gg.enable = isCloudflareWorker() ? () => {} : debugFactory.enable;

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
	// Method chaining: fg('red').bg('green')
	fg: (color: string) => ChainableColorFn;
	bg: (color: string) => ChainableColorFn;
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
 * Internal helper to create chainable color function with method chaining
 */
function createColorFunction(fgCode: string = '', bgCode: string = ''): ChainableColorFn {
	const tagFn = function (strings: TemplateStringsArray, ...values: unknown[]): string {
		const text = strings.reduce(
			(acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''),
			''
		);
		return fgCode + bgCode + text + '\x1b[0m';
	};

	// Add method chaining
	tagFn.fg = (color: string) => {
		const rgb = parseColor(color);
		const newFgCode = rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m` : '';
		return createColorFunction(newFgCode, bgCode);
	};

	tagFn.bg = (color: string) => {
		const rgb = parseColor(color);
		const newBgCode = rgb ? `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m` : '';
		return createColorFunction(fgCode, newBgCode);
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
		options: { ns: string; file?: string; line?: number; col?: number; src?: string },
		...args: unknown[]
	) => unknown;
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
