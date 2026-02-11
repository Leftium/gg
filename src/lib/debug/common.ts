/**
 * Internal debug implementation — replaces the `debug` npm package.
 *
 * Core logic: createDebug factory, enable/disable, namespace matching,
 * color selection, and humanize (ms formatting).
 */

/** Format ms like debug's `ms` package: 0ms, 500ms, 5s, 2m, 1h, 3d */
export function humanize(ms: number): string {
	const abs = Math.abs(ms);
	if (abs >= 86_400_000) return Math.round(ms / 86_400_000) + 'd';
	if (abs >= 3_600_000) return Math.round(ms / 3_600_000) + 'h';
	if (abs >= 60_000) return Math.round(ms / 60_000) + 'm';
	if (abs >= 1_000) return Math.round(ms / 1_000) + 's';
	return ms + 'ms';
}

/**
 * Wildcard pattern matching (same algorithm as debug's `matchesTemplate`).
 * Supports `*` as a wildcard that matches any sequence of characters.
 */
function matchesTemplate(search: string, template: string): boolean {
	let si = 0;
	let ti = 0;
	let starIdx = -1;
	let matchIdx = 0;

	while (si < search.length) {
		if (ti < template.length && (template[ti] === search[si] || template[ti] === '*')) {
			if (template[ti] === '*') {
				starIdx = ti;
				matchIdx = si;
				ti++;
			} else {
				si++;
				ti++;
			}
		} else if (starIdx !== -1) {
			ti = starIdx + 1;
			matchIdx++;
			si = matchIdx;
		} else {
			return false;
		}
	}

	while (ti < template.length && template[ti] === '*') {
		ti++;
	}

	return ti === template.length;
}

// ── Types ──────────────────────────────────────────────────────────────

export interface Debugger {
	(...args: unknown[]): void;
	namespace: string;
	color: string;
	diff: number;
	enabled: boolean;
	useColors: boolean;
	formatArgs: (args: unknown[]) => void;
	log: ((...args: unknown[]) => void) | null;
}

export interface DebugFactory {
	(namespace: string): Debugger;
	enable: (namespaces: string) => void;
	disable: () => string;
	enabled: (namespace: string) => boolean;
	humanize: typeof humanize;
	names: string[];
	skips: string[];
	namespaces: string;
	formatters: Record<string, (this: Debugger, val: unknown) => string>;
}

/** Platform-specific hooks provided by browser.ts or node.ts */
export interface DebugEnv {
	formatArgs: (this: Debugger, args: unknown[]) => void;
	save: (namespaces: string) => void;
	load: () => string;
	useColors: () => boolean;
	colors: string[] | number[];
	log: (...args: unknown[]) => void;
	formatters?: Record<string, (this: Debugger, val: unknown) => string>;
	init?: (instance: Debugger) => void;
}

// ── Factory ────────────────────────────────────────────────────────────

export function setup(env: DebugEnv): DebugFactory {
	/** Deterministic color for a namespace (same hash as debug@4) */
	function selectColor(namespace: string): string | number {
		let hash = 0;
		for (let i = 0; i < namespace.length; i++) {
			hash = ((hash << 5) - hash) + namespace.charCodeAt(i);
			hash |= 0;
		}
		return env.colors[Math.abs(hash) % env.colors.length];
	}

	// Active include/exclude lists
	let names: string[] = [];
	let skips: string[] = [];
	let currentNamespaces = '';

	function enable(namespaces: string): void {
		env.save(namespaces);
		currentNamespaces = namespaces;

		names = [];
		skips = [];

		const parts = (typeof namespaces === 'string' ? namespaces : '')
			.trim()
			.replace(/\s+/g, ',')
			.split(',')
			.filter(Boolean);

		for (const part of parts) {
			if (part[0] === '-') {
				skips.push(part.slice(1));
			} else {
				names.push(part);
			}
		}

		// Update factory-level arrays for external inspection
		factory.names = names;
		factory.skips = skips;
		factory.namespaces = currentNamespaces;
	}

	function disable(): string {
		const prev = [
			...names,
			...skips.map((ns) => '-' + ns)
		].join(',');
		enable('');
		return prev;
	}

	function enabled(name: string): boolean {
		for (const skip of skips) {
			if (matchesTemplate(name, skip)) return false;
		}
		for (const ns of names) {
			if (matchesTemplate(name, ns)) return true;
		}
		return false;
	}

	// ── createDebug ────────────────────────────────────────────────────

	function createDebug(namespace: string): Debugger {
		let prevTime: number | undefined;
		let enableOverride: boolean | null = null;
		let namespacesCache: string | undefined;
		let enabledCache: boolean | undefined;

		const debug = function (...args: unknown[]): void {
			if (!debug.enabled) return;

			const curr = Date.now();
			const ms = curr - (prevTime || curr);
			debug.diff = ms;
			prevTime = curr;

			// Coerce first arg
			if (typeof args[0] !== 'string') {
				args.unshift('%O');
			}

			// Apply %format replacements
			let idx = 0;
			args[0] = (args[0] as string).replace(/%([a-zA-Z%])/g, (match, fmt: string) => {
				if (match === '%%') return '%';
				idx++;
				const formatter = factory.formatters[fmt];
				if (typeof formatter === 'function') {
					const val = args[idx];
					match = formatter.call(debug, val);
					args.splice(idx, 1);
					idx--;
				}
				return match;
			});

			// Platform-specific formatting (colors, prefix)
			debug.formatArgs(args);

			const logFn = debug.log || env.log;
			logFn.apply(debug, args);
		} as Debugger;

		debug.namespace = namespace;
		debug.useColors = env.useColors();
		debug.color = String(selectColor(namespace));
		debug.diff = 0;
		debug.log = null;

		debug.formatArgs = function (args: unknown[]) {
			env.formatArgs.call(debug, args);
		};

		Object.defineProperty(debug, 'enabled', {
			enumerable: true,
			configurable: false,
			get: () => {
				if (enableOverride !== null) return enableOverride;
				if (namespacesCache !== currentNamespaces) {
					namespacesCache = currentNamespaces;
					enabledCache = enabled(namespace);
				}
				return enabledCache;
			},
			set: (v: boolean) => {
				enableOverride = v;
			}
		});

		if (env.init) {
			env.init(debug);
		}

		return debug;
	}

	// ── Assemble factory ───────────────────────────────────────────────

	const factory = createDebug as unknown as DebugFactory;
	factory.enable = enable;
	factory.disable = disable;
	factory.enabled = enabled;
	factory.humanize = humanize;
	factory.names = names;
	factory.skips = skips;
	factory.namespaces = '';
	factory.formatters = { ...env.formatters };

	// Initialize from persisted namespaces
	enable(env.load());

	return factory;
}
