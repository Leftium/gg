/**
 * Node.js-specific debug implementation.
 *
 * Output: process.stderr via util.formatWithOptions.
 * Persistence: process.env.DEBUG
 * Format (patched): +123ms namespace message (ANSI colored)
 */

import { setup, humanize, type Debugger, type DebugEnv, type DebugFactory } from './common.js';
import tty from 'tty';
import util from 'util';

/**
 * Basic ANSI colors (6) — used when 256-color support is not detected.
 * Extended 256-color palette matches debug@4 for color-hash stability.
 */
const basicColors: number[] = [6, 2, 3, 4, 5, 1];

const extendedColors: number[] = [
	20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45,
	56, 57, 62, 63, 68, 69, 74, 75, 76, 77, 78, 79, 80, 81,
	92, 93, 98, 99, 112, 113, 128, 129, 134, 135, 148, 149,
	160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171,
	172, 173, 178, 179, 184, 185, 196, 197, 198, 199, 200, 201,
	202, 203, 204, 205, 206, 207, 208, 209, 214, 215, 220, 221
];

/** Detect 256-color support via supports-color (optional) or heuristic */
function detectColors(): number[] {
	try {
		// Try supports-color if available (same as debug@4)
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const supportsColor = require('supports-color');
		if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
			return extendedColors;
		}
	} catch {
		// Not installed — fall through
	}
	return basicColors;
}

/**
 * Build inspectOpts from DEBUG_* environment variables.
 * Supports: DEBUG_COLORS, DEBUG_DEPTH, DEBUG_SHOW_HIDDEN, DEBUG_HIDE_DATE
 */
const inspectOpts: Record<string, unknown> = Object.keys(process.env)
	.filter((key) => /^debug_/i.test(key))
	.reduce<Record<string, unknown>>((obj, key) => {
		const prop = key
			.substring(6)
			.toLowerCase()
			.replace(/_([a-z])/g, (_, k: string) => k.toUpperCase());

		let val: unknown = process.env[key];
		if (/^(yes|on|true|enabled)$/i.test(val as string)) val = true;
		else if (/^(no|off|false|disabled)$/i.test(val as string)) val = false;
		else if (val === 'null') val = null;
		else val = Number(val);

		obj[prop] = val;
		return obj;
	}, {});

function useColors(): boolean {
	return 'colors' in inspectOpts
		? Boolean(inspectOpts.colors)
		: tty.isatty(process.stderr.fd);
}

function getDate(): string {
	if (inspectOpts.hideDate) return '';
	return new Date().toISOString() + ' ';
}

/**
 * Format args with ANSI colors and gg's patched prefix order:
 *   +123ms namespace message
 */
function formatArgs(this: Debugger, args: unknown[]): void {
	const name = this.namespace;
	const useCol = this.useColors;

	if (useCol) {
		const c = Number(this.color);
		const colorCode = '\u001B[3' + (c < 8 ? String(c) : '8;5;' + c);
		const h = ('+' + humanize(this.diff)).padStart(6);
		const prefix = `${colorCode};1m${h} ${name} \u001B[0m`;

		args[0] = prefix + String(args[0]).split('\n').join('\n' + prefix);
		// Append empty color reset (preserves arg count parity from original debug)
		args.push(colorCode + '' + '\u001B[0m');
	} else {
		args[0] = getDate() + name + ' ' + args[0];
	}
}

function log(this: Debugger, ...args: unknown[]): void {
	process.stderr.write(util.formatWithOptions(inspectOpts, ...args) + '\n');
}

function save(namespaces: string): void {
	if (namespaces) {
		process.env.DEBUG = namespaces;
	} else {
		delete process.env.DEBUG;
	}
}

function load(): string {
	return process.env.DEBUG || '';
}

function init(instance: Debugger): void {
	// Each instance gets its own inspectOpts copy (for per-instance color override)
	(instance as Debugger & { inspectOpts: Record<string, unknown> }).inspectOpts = { ...inspectOpts };
}

const env: DebugEnv = {
	formatArgs,
	save,
	load,
	useColors,
	colors: detectColors(),
	log,
	init,
	formatters: {
		/** %o → util.inspect, single line */
		o(this: Debugger, v: unknown): string {
			const opts = (this as Debugger & { inspectOpts?: Record<string, unknown> }).inspectOpts || {};
			opts.colors = this.useColors;
			return util.inspect(v, opts as util.InspectOptions)
				.split('\n')
				.map((str) => str.trim())
				.join(' ');
		},
		/** %O → util.inspect, multi-line */
		O(this: Debugger, v: unknown): string {
			const opts = (this as Debugger & { inspectOpts?: Record<string, unknown> }).inspectOpts || {};
			opts.colors = this.useColors;
			return util.inspect(v, opts as util.InspectOptions);
		}
	}
};

const debug: DebugFactory = setup(env);
export default debug;
