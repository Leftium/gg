/**
 * Node.js-specific debug implementation.
 *
 * Output: process.stderr via util.formatWithOptions.
 * Persistence: process.env.DEBUG
 * Format (patched): +123ms namespace message (ANSI colored)
 *
 * IMPORTANT: No static imports of Node built-ins (tty, util).
 * Vite 8's rolldown statically resolves even dynamic `import('tty')` when
 * it appears as a bare specifier, pulling in a `createRequire(import.meta.url)`
 * shim that breaks Cloudflare Workers (where import.meta.url is undefined).
 * Instead, tty and util are loaded lazily and accessed through mutable
 * module-level variables with synchronous fallbacks.
 */

import { setup, humanize, type Debugger, type DebugEnv, type DebugFactory } from './common.js';

// ── Lazy-loaded Node modules ────────────────────────────────────────────
// Loaded asynchronously at module init; functions fall back gracefully
// until the modules are available (typically resolved within one microtask).

let ttyModule: typeof import('tty') | null = null;
let utilModule: typeof import('util') | null = null;

/** Promise that resolves once tty + util are loaded (or failed). */
export const nodeModulesReady: Promise<void> = (async () => {
	try {
		// Use Function constructor to create a truly opaque import that
		// no bundler can statically analyze. This prevents Vite 8/rolldown
		// from resolving the specifier and injecting createRequire shims.
		const dynamicImport = new Function('specifier', 'return import(specifier)') as (
			specifier: string
		) => Promise<Record<string, unknown>>;
		const [tty, util] = await Promise.all([dynamicImport('tty'), dynamicImport('util')]);
		ttyModule = tty as typeof import('tty');
		utilModule = util as typeof import('util');
	} catch {
		// Not available (e.g., Cloudflare Workers) — fallbacks remain active
	}
})();

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

/**
 * Detect 256-color support using environment heuristics.
 *
 * Previous versions used `require('supports-color')` here, but that pulls
 * the CJS supports-color package into the SSR bundle. supports-color
 * internally does `require('os')` and `require('tty')`, which causes
 * Vite 8/rolldown to emit a `createRequire(import.meta.url)` runtime
 * shim that breaks Cloudflare Workers (where import.meta.url is undefined).
 *
 * Instead, we use the same TERM/COLORTERM heuristics that supports-color
 * itself uses, avoiding the problematic CJS dependency chain.
 */
function detectColors(): number[] {
	if (typeof process === 'undefined' || !process.env) return basicColors;

	// Check FORCE_COLOR env var (same as supports-color)
	const forceColor = process.env.FORCE_COLOR;
	if (forceColor === '0' || forceColor === 'false') return basicColors;
	if (forceColor !== undefined) return extendedColors;

	// No color if not a TTY (unless forced)
	if (ttyModule) {
		try {
			if (!ttyModule.isatty((process.stderr as unknown as { fd: number }).fd)) {
				return basicColors;
			}
		} catch {
			return basicColors;
		}
	}

	// Check for 256-color support via TERM/COLORTERM
	const term = process.env.TERM || '';
	const colorterm = process.env.COLORTERM || '';
	if (colorterm === 'truecolor' || colorterm === '24bit' || term === 'xterm-256color') {
		return extendedColors;
	}

	return basicColors;
}

/**
 * Build inspectOpts from DEBUG_* environment variables.
 * Supports: DEBUG_COLORS, DEBUG_DEPTH, DEBUG_SHOW_HIDDEN, DEBUG_HIDE_DATE
 */
const inspectOpts: Record<string, unknown> = (typeof process !== 'undefined' && process.env
	? Object.keys(process.env)
	: []
)
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
	if ('colors' in inspectOpts) return Boolean(inspectOpts.colors);
	// ttyModule may not be loaded yet on first call — default to false
	if (!ttyModule) return false;
	try {
		return ttyModule.isatty((process.stderr as unknown as { fd: number }).fd);
	} catch {
		return false;
	}
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
	if (utilModule && typeof process !== 'undefined' && process.stderr) {
		process.stderr.write(utilModule.formatWithOptions(inspectOpts, ...args) + '\n');
	} else if (typeof process !== 'undefined' && process.stderr) {
		// Fallback: no util available yet (or ever on Cloudflare)
		process.stderr.write(args.map(String).join(' ') + '\n');
	} else {
		// Last resort
		console.error(...args);
	}
}

function save(namespaces: string): void {
	if (typeof process === 'undefined') return;
	if (namespaces) {
		process.env.GG_KEEP = namespaces;
	} else {
		delete process.env.GG_KEEP;
	}
}

function load(): string {
	// GG_KEEP controls which namespaces are kept (and thus output to the server console).
	// Fall back to '*' so gg works zero-config in dev without setting any env var.
	if (typeof process === 'undefined') return '*';
	return process.env.GG_KEEP || '*';
}

function init(instance: Debugger): void {
	// Each instance gets its own inspectOpts copy (for per-instance color override)
	(instance as Debugger & { inspectOpts: Record<string, unknown> }).inspectOpts = { ...inspectOpts };
}

/** util.inspect wrapper with fallback */
function inspectValue(v: unknown, opts: Record<string, unknown>): string {
	if (utilModule) {
		return utilModule.inspect(v, opts as import('util').InspectOptions);
	}
	// Fallback when util is not yet loaded
	try {
		return JSON.stringify(v, null, 2) ?? String(v);
	} catch {
		return String(v);
	}
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
			return inspectValue(v, opts)
				.split('\n')
				.map((str) => str.trim())
				.join(' ');
		},
		/** %O → util.inspect, multi-line */
		O(this: Debugger, v: unknown): string {
			const opts = (this as Debugger & { inspectOpts?: Record<string, unknown> }).inspectOpts || {};
			opts.colors = this.useColors;
			return inspectValue(v, opts);
		}
	}
};

const debug: DebugFactory = setup(env);
export default debug;
