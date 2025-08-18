import debugFactory from 'debug';
import ErrorStackParser from 'error-stack-parser';
import { BROWSER } from 'esm-env';

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

const ggConfig = {
	enabled: !isCloudflareWorker(), // Disable in CloudFlare Workers
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

function openInEditorUrl(fileName: string) {
	return ggConfig.openInEditorUrlTemplate.replace(
		'$FILENAME',
		encodeURIComponent(fileName).replaceAll('%2F', '/')
	);
}

// http://localhost:5173/__open-in-editor?file=src%2Froutes%2F%2Bpage.svelte

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

	// Ignore first stack frame, which is always the call to gg() itself.
	const stack = ErrorStackParser.parse(new Error()).splice(1);

	// Example: http://localhost:5173/src/routes/+page.svelte
	const filename = stack[0].fileName?.replace(timestampRegex, '') || '';

	// Example: src/routes/+page.svelte
	const filenameToOpen = filename.replace(srcRootRegex, '$<folderName>/');
	const url = openInEditorUrl(filenameToOpen);

	// Example: routes/+page.svelte
	const filenameToDisplay = filename.replace(srcRootRegex, '');

	const { functionName } = stack[0];

	//console.log({ filename, fileNameToOpen: filenameToOpen, fileNameToDisplay: filenameToDisplay });

	// A callpoint is uniquely identified by the filename plus function name
	const callpoint = `${filenameToDisplay}${functionName ? `@${functionName}` : ''}`;

	if (callpoint.length < 80 && callpoint.length > maxCallpointLength) {
		maxCallpointLength = callpoint.length;
	}

	const namespace = `gg:${callpoint.padEnd(maxCallpointLength, ' ')}${ggConfig.editorLink ? url : ''}`;
	const ggLogFunction =
		namespaceToLogFunction.get(namespace) ||
		namespaceToLogFunction.set(namespace, debugFactory(namespace)).get(namespace)!;

	if (!args.length) {
		ggLogFunction(`    📝📝 ${url} 👀👀`);
		return {
			fileName: filenameToDisplay,
			functionName,
			url,
			stack
		};
	}

	// Handle the case where args might be empty or have any number of arguments
	if (args.length === 1) {
		ggLogFunction(args[0]);
	} else {
		ggLogFunction(args[0], ...args.slice(1));
	}
	return args[0];
}

gg.disable = isCloudflareWorker() ? () => {} : debugFactory.disable;

gg.enable = isCloudflareWorker() ? () => {} : debugFactory.enable;

// Log some gg info to the JS console/terminal:

if (ggConfig.showHints && !isCloudflareWorker()) {
	const ggLogTest = debugFactory('gg:TEST');

	let ggMessage = '\n';
	// Utilities for forming ggMessage:
	const message = (s: string) => (ggMessage += `${s}\n`);
	const checkbox = (test: boolean) => (test ? '✅' : '❌');
	const makeHint = (test: boolean, ifTrue: string, ifFalse = '') => (test ? ifTrue : ifFalse);

	console.log(`Loaded gg module. Checking configuration...`);
	if (ggConfig.enabled && ggLogTest.enabled) {
		gg('If you can see this logg, gg configured correctly!');
		message(`No problems detected:`);
		if (BROWSER) {
			message(
				`ℹ️ If gg output still not visible above, enable "Verbose" log level in browser DevTools.`
			);
		}
	} else {
		message(`Problems detected; fix all ❌:`);
	}

	const hint = makeHint(!ggConfig.enabled, ' (Update value in gg.ts file.)');
	message(`${checkbox(ggConfig.enabled)} ggConfig.enabled: ${ggConfig.enabled}${hint}`);

	if (BROWSER) {
		const hint = makeHint(!ggLogTest.enabled, " (Try `localStorage.debug = 'gg:*'`)");
		message(`${checkbox(ggLogTest.enabled)} localStorage.debug: ${localStorage?.debug}${hint}`);

		const { status } = await fetch('/__open-in-editor?file=+');
		message(
			makeHint(
				status === 222,
				`✅ (optional) open-in-editor vite plugin detected! (status code: ${status})`,
				`⚠️ (optional) open-in-editor vite plugin not detected. (status code: ${status}.) Add plugin in vite.config.ts`
			)
		);
	} else {
		const hint = makeHint(!ggLogTest.enabled, ' (Try `DEBUG=gg:* npm dev`)');
		if (dotenvModule) {
			dotenvModule.config(); // Load the environment variables
		}
		message(`${checkbox(ggLogTest.enabled)} DEBUG env variable: ${process?.env?.DEBUG}${hint}`);
	}

	console.log(ggMessage);
}
