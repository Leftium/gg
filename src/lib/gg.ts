import debugFactory from './debug.js';
import ErrorStackParser from 'error-stack-parser';
import { BROWSER, DEV } from 'esm-env';

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

const timestampRegex = /(\?t=\d+)?$/;

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

/**
 * Reset the namespace width tracking.
 * Useful after configuration checks that may have long callpoint paths.
 */
function resetNamespaceWidth() {
	maxCallpointLength = 0;
}

function openInEditorUrl(fileName: string) {
	return ggConfig.openInEditorUrlTemplate.replace(
		'$FILENAME',
		encodeURIComponent(fileName).replaceAll('%2F', '/')
	);
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
}

type OnLogCallback = (entry: CapturedEntry) => void;

// Overload signatures
export function gg(): {
	fileName: string;
	functionName: string;
	url: string;
	stack: ErrorStackParser.StackFrame[];
};
export function gg<T>(arg: T, ...args: unknown[]): T;

export function gg(...args: unknown[]) {
	if (!ggConfig.enabled || isCloudflareWorker()) {
		return args.length ? args[0] : { url: '', stack: [] };
	}

	// Initialize return values
	let fileName = '';
	let functionName = '';
	let url = '';
	let stack: ErrorStackParser.StackFrame[] = [];
	let namespace = 'gg:';

	// In development: calculate detailed callpoint information
	// In production: skip expensive stack parsing and use simple namespace
	if (DEV) {
		// Ignore first stack frame, which is always the call to gg() itself.
		stack = ErrorStackParser.parse(new Error()).splice(1);

		// Example: http://localhost:5173/src/routes/+page.svelte
		const filename = stack[0].fileName?.replace(timestampRegex, '') || '';

		// Example: src/routes/+page.svelte
		const filenameToOpen = filename.replace(srcRootRegex, '$<folderName>/');
		url = openInEditorUrl(filenameToOpen);

		// Example: routes/+page.svelte
		fileName = filename.replace(srcRootRegex, '');
		functionName = stack[0].functionName || '';

		// A callpoint is uniquely identified by the filename plus function name
		const callpoint = `${fileName}${functionName ? `@${functionName}` : ''}`;

		if (callpoint.length < 80 && callpoint.length > maxCallpointLength) {
			maxCallpointLength = callpoint.length;
		}

		// Namespace without padding - keeps colors stable
		// Editor link appended if enabled
		namespace = `gg:${callpoint}${ggConfig.editorLink ? url : ''}`;
	}

	const ggLogFunction =
		namespaceToLogFunction.get(namespace) ||
		namespaceToLogFunction.set(namespace, createGgDebugger(namespace)).get(namespace)!;

	// Prepare args for logging
	let logArgs: unknown[];
	let returnValue: unknown;

	if (!args.length) {
		// No arguments: log editor link
		logArgs = [`    📝📝 ${url} 👀👀`];
		returnValue = {
			fileName,
			functionName,
			url,
			stack
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
}

/**
 * Run gg diagnostics and log configuration status
 * Can be called immediately or delayed (e.g., after Eruda loads)
 */
export async function runGgDiagnostics() {
	if (!ggConfig.showHints || isCloudflareWorker()) return;

	const ggLogTest = debugFactory('gg:TEST');

	let ggMessage = '\n';
	// Utilities for forming ggMessage:
	const message = (s: string) => (ggMessage += `${s}\n`);
	const checkbox = (test: boolean) => (test ? '✅' : '❌');
	const makeHint = (test: boolean, ifTrue: string, ifFalse = '') => (test ? ifTrue : ifFalse);

	// Use plain console.log for diagnostics - appears in Eruda's Console tab
	console.log(`Loaded gg module. Checking configuration...`);
	if (ggConfig.enabled && ggLogTest.enabled) {
		gg('If you can see this logg, gg configured correctly!');
		message(`No problems detected:`);
		if (BROWSER) {
			message(
				`ℹ️ If gg output not visible: enable "Verbose" log level in DevTools, or check Eruda's GG tab.`
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

	if (BROWSER) {
		const hint = makeHint(!ggLogTest.enabled, " (Try `localStorage.debug = 'gg:*'`)");
		message(`${checkbox(ggLogTest.enabled)} localStorage.debug: ${localStorage?.debug}${hint}`);

		if (DEV) {
			const { status } = await fetch('/__open-in-editor?file=+');
			message(
				makeHint(
					status === 222,
					`✅ (optional) open-in-editor vite plugin detected! (status code: ${status})`,
					`⚠️ (optional) open-in-editor vite plugin not detected. (status code: ${status}.) Add plugin in vite.config.ts`
				)
			);
		}
	} else {
		const hint = makeHint(!ggLogTest.enabled, ' (Try `DEBUG=gg:* npm dev`)');
		if (dotenvModule) {
			dotenvModule.config(); // Load the environment variables
		}
		message(`${checkbox(ggLogTest.enabled)} DEBUG env variable: ${process?.env?.DEBUG}${hint}`);
	}

	// Use plain console.log for diagnostics - appears in Eruda's Console tab
	console.log(ggMessage);

	// Reset namespace width after configuration check
	// This prevents the long callpoint from the config check from affecting subsequent logs
	resetNamespaceWidth();
}

// Run diagnostics immediately on module load if Eruda is not being used
// (If Eruda will load, the loader will call runGgDiagnostics after Eruda is ready)
if (ggConfig.showHints && !isCloudflareWorker()) {
	// Only run immediately if we're not in a context where Eruda might load
	// In browser dev mode, assume Eruda might load and skip immediate diagnostics
	if (!BROWSER || !DEV) {
		runGgDiagnostics();
	}
}
