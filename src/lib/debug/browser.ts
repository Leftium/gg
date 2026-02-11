/**
 * Browser-specific debug implementation.
 *
 * Output: console.debug with %c CSS color formatting.
 * Persistence: localStorage.debug
 * Format (patched): +123ms namespace message
 */

import { setup, humanize, type Debugger, type DebugEnv, type DebugFactory } from './common.js';

/**
 * 76 hex colors — identical to debug@4 browser.js for color-hash stability.
 */
const colors: string[] = [
	'#0000CC', '#0000FF', '#0033CC', '#0033FF', '#0066CC', '#0066FF',
	'#0099CC', '#0099FF', '#00CC00', '#00CC33', '#00CC66', '#00CC99',
	'#00CCCC', '#00CCFF', '#3300CC', '#3300FF', '#3333CC', '#3333FF',
	'#3366CC', '#3366FF', '#3399CC', '#3399FF', '#33CC00', '#33CC33',
	'#33CC66', '#33CC99', '#33CCCC', '#33CCFF', '#6600CC', '#6600FF',
	'#6633CC', '#6633FF', '#66CC00', '#66CC33', '#9900CC', '#9900FF',
	'#9933CC', '#9933FF', '#99CC00', '#99CC33', '#CC0000', '#CC0033',
	'#CC0066', '#CC0099', '#CC00CC', '#CC00FF', '#CC3300', '#CC3333',
	'#CC3366', '#CC3399', '#CC33CC', '#CC33FF', '#CC6600', '#CC6633',
	'#CC9900', '#CC9933', '#CCCC00', '#CCCC33', '#FF0000', '#FF0033',
	'#FF0066', '#FF0099', '#FF00CC', '#FF00FF', '#FF3300', '#FF3333',
	'#FF3366', '#FF3399', '#FF33CC', '#FF33FF', '#FF6600', '#FF6633',
	'#FF9900', '#FF9933', '#FFCC00', '#FFCC33'
];

function useColors(): boolean {
	// Modern browsers all support %c — simplified from debug's original checks
	return typeof document !== 'undefined' || typeof navigator !== 'undefined';
}

/**
 * Format args with color CSS and gg's patched prefix order:
 *   +123ms namespace message
 */
function formatArgs(this: Debugger, args: unknown[]): void {
	const h = humanize(this.diff);
	const prefix = ('+' + h).padStart(6);

	args[0] = (this.useColors ? '%c' : '') +
		`${prefix} ${this.namespace}` +
		(this.useColors ? ' %c' : ' ') +
		args[0] +
		(this.useColors ? '%c ' : ' ');

	if (!this.useColors) return;

	const c = 'color: ' + this.color;
	args.splice(1, 0, c, 'color: inherit');

	// Insert CSS for the final %c
	let index = 0;
	let lastC = 0;
	(args[0] as string).replace(/%[a-zA-Z%]/g, (match) => {
		if (match === '%%') return match;
		index++;
		if (match === '%c') lastC = index;
		return match;
	});

	args.splice(lastC, 0, c);
}

function save(namespaces: string): void {
	try {
		if (namespaces) {
			localStorage.setItem('debug', namespaces);
		} else {
			localStorage.removeItem('debug');
		}
	} catch {
		// localStorage may not be available
	}
}

function load(): string {
	try {
		return localStorage.getItem('debug') || localStorage.getItem('DEBUG') || '';
	} catch {
		return '';
	}
}

const log = console.debug || console.log || (() => {});

const env: DebugEnv = {
	formatArgs,
	save,
	load,
	useColors,
	colors,
	log,
	formatters: {
		/** %j → JSON.stringify (preserved for compatibility) */
		j(v: unknown): string {
			try {
				return JSON.stringify(v);
			} catch (e) {
				return '[UnexpectedJSONParseError]: ' + (e as Error).message;
			}
		}
	}
};

const debug: DebugFactory = setup(env);
export default debug;
