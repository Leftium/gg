import * as dotenv from 'dotenv';

import debugFactory from 'debug';
import ErrorStackParser from 'error-stack-parser';

import { BROWSER } from 'esm-env';

import http from 'http';
import type { AddressInfo } from 'net';

function findAvailablePort(startingPort: number) {
	return new Promise((resolve) => {
		const server = http.createServer();
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

function getServerPort() {
	return new Promise((resolve) => {
		if (BROWSER) {
			// Browser environment
			const currentPort =
				window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
			console.log(`This is running in the browser on port: ${currentPort}`);

			// Resolve the promise with the detected port
			resolve(currentPort);
		} else {
			// Node.js environment
			const startingPort = Number(process.env.PORT) || 5173; // Default to Vite's default port

			findAvailablePort(startingPort).then((actualPort) => {
				console.log(`Server is running on http://localhost:${actualPort}`);
				resolve(actualPort);
			});
		}
	});
}

const port = await getServerPort();

const ggConfig = {
	enabled: true,
	showHints: true,
	openInEditorUrlTemplate: `http://localhost:${port}/__open-in-editor?file=$FILENAME`,

	// The srcRoot contains all source files.
	// filename A        : http://localhost:5173/src/routes/+layout.svelte
	// filename B        : http://localhost:5173/src/lib/gg.ts
	// srcRootprefix     : http://localhost:5173/src/
	// <folderName> group:                       src
	srcRootPattern: '.*?(/(?<folderName>src|chunks)/)'
};
const srcRootRegex = new RegExp(ggConfig.srcRootPattern, 'i');

function openInEditorUrl(fileName: string) {
	return ggConfig.openInEditorUrlTemplate.replace(
		'$FILENAME',
		encodeURIComponent(fileName).replaceAll('%2F', '/')
	);
}

// http://localhost:5173/__open-in-editor?file=src%2Froutes%2F%2Bpage.svelte

const ggLog = debugFactory('gg');

// Log some gg info to the JS console/terminal:

if (ggConfig.showHints) {
	const ggLogTest = ggLog.extend('TEST');

	let ggMessage = '';
	// Utilities for forming ggMessage:
	const message = (s: string) => (ggMessage += `${s}\n`);
	const checkbox = (test: boolean) => (test ? '✅' : '❌');
	const makeHint = (test: boolean, ifTrue: string, ifFalse = '') => (test ? ifTrue : ifFalse);

	message(`Loaded gg module. To enable output of loggs:`);

	const hint = makeHint(!ggConfig.enabled, ' (Update value in gg.ts file.)');
	message(`${checkbox(ggConfig.enabled)} ggConfig.enabled: ${ggConfig.enabled}${hint}`);

	if (BROWSER) {
		const hint = makeHint(!ggLogTest.enabled, " (Try `localStorage.debug = 'gg:*'`)");
		message(`${checkbox(ggLogTest.enabled)} localStorage.debug: ${localStorage?.debug}${hint}`);

		message(`ℹ️ "Verbose" log level must be enabled (in the browser DevTools.)`);

		const { status } = await fetch('/__open-in-editor?file=+');
		message(
			makeHint(
				status === 222,
				`✅ (optional) open-in-editor vite plugin detected! (${status})`,
				`⚠️ (optional) open-in-editor vite plugin not detected. (${status})`
			)
		);
	} else {
		const hint = makeHint(!ggLogTest.enabled, ' (Try `DEBUG=gg:*`)');
		dotenv.config(); // Load the environment variables
		message(`${checkbox(ggLogTest.enabled)} DEBUG env variable: ${process?.env?.DEBUG}${hint}`);
	}

	console.log(ggMessage);
}

// To maintain unique millisecond diffs for each callpoint:
// - Create a unique log function for each callpoint.
// - Cache and reuse the same log function for a given callpoint.
const callpointToLogFunction = new Map();

const timestampRegex = /(\?t=\d+)?$/;

// Overload signatures
export function gg(): {
	fileName: string;
	functionName: string;
	url: string;
	stack: ErrorStackParser.StackFrame[];
};
export function gg<T>(arg: T, ...args: unknown[]): T;

export function gg(...args: [...unknown[]]) {
	if (!ggConfig.enabled) {
		return args[0];
	}

	// Ignore first stack frame, which is always the call to gg() itself.
	const stack = ErrorStackParser.parse(new Error()).splice(1);

	// Example: http://localhost:5173/src/routes/+page.svelte
	const filename = stack[0].fileName?.replace(timestampRegex, '') || '';

	// Example: src/routes/+page.svelte
	const filenameToOpen = filename.replace(srcRootRegex, '$<folderName>/');

	// Example: routes/+page.svelte
	const filenameToDisplay = filename.replace(srcRootRegex, '');

	const { functionName } = stack[0];

	//console.log({ filename, fileNameToOpen: filenameToOpen, fileNameToDisplay: filenameToDisplay });

	// A callpoint is uniquely identified by the filename plus function name
	const callpoint = `${filenameToDisplay}@${stack[0].functionName}`;
	const ggLogFunction =
		callpointToLogFunction.get(callpoint) ||
		callpointToLogFunction.set(callpoint, ggLog.extend(callpoint)).get(callpoint);

	if (!args.length) {
		const url = openInEditorUrl(filenameToOpen);
		ggLogFunction(`📝📝📝 ${url} 👀👀👀`);
		return {
			fileName: filenameToDisplay,
			functionName,
			url,
			stack
		};
	}

	ggLogFunction(...(args as [formatter: unknown, ...args: unknown[]]));
	return args[0];
}

gg.disable = debugFactory.disable;
gg.enable = debugFactory.enable;
