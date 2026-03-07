/**
 * Options for initializing the gg Eruda plugin
 */
export interface GgErudaOptions {
	/**
	 * How to load in production
	 * @default ['url-param', 'gesture']
	 */
	prod?:
		| Array<'url-param' | 'localStorage' | 'gesture'>
		| 'url-param'
		| 'localStorage'
		| 'gesture'
		| false;

	/**
	 * Max captured log entries (ring buffer)
	 * @default 2000
	 */
	maxEntries?: number;

	/**
	 * Additional Eruda options passed to eruda.init()
	 * @default {}
	 */
	erudaOptions?: Record<string, unknown>;

	/**
	 * Whether to open the GgConsole panel on load (not just the floating icon)
	 * @default false
	 */
	open?: boolean;
}

/** Log severity level */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * A captured log entry from gg()
 */
export interface CapturedEntry {
	/** Namespace (e.g., "routes/+page.svelte@handleClick") */
	namespace: string;
	/** Color assigned by the debug library (e.g., "#CC3366") */
	color: string;
	/** Millisecond diff from previous log (e.g., 0, 123) */
	diff: number;
	/** Formatted message string */
	message: string;
	/** Raw arguments for expandable view */
	args: unknown[];
	/** Timestamp */
	timestamp: number;
	/** Source file path for open-in-editor (e.g., "src/routes/blog/[slug]/+page.svelte") */
	file?: string;
	/** Source line number */
	line?: number;
	/** Source column number */
	col?: number;
	/** Source expression text for icecream-style display (e.g., "user.name") */
	src?: string;
	/** Log severity level (default: 'debug') */
	level?: LogLevel;
	/** Stack trace string (captured for error/trace calls) */
	stack?: string;
	/** Structured table data for gg.table() — Eruda renders as HTML table */
	tableData?: { keys: string[]; rows: Array<Record<string, unknown>> };
}

/**
 * Tracks loggs dropped by the keep gate (Layer 1) for a single namespace.
 * Maintained outside the ring buffer — does not consume buffer slots.
 * The `preview` field holds the most recent dropped logg so the future
 * sentinel UI can show what the namespace is producing right now.
 */
export interface DroppedNamespaceInfo {
	namespace: string;
	/** Timestamp of the first dropped logg for this namespace */
	firstSeen: number;
	/** Timestamp of the most recent dropped logg */
	lastSeen: number;
	/** Total number of dropped loggs across all time */
	total: number;
	/** Count per logg type key ('log' for unlabelled calls, or 'debug'/'info'/'warn'/'error') */
	byType: Record<string, number>;
	/** Most recent dropped logg — overwritten on each drop, used for sentinel preview */
	preview: CapturedEntry;
}

/**
 * Eruda plugin interface
 */
export interface ErudaPlugin {
	name: string;
	init($el: HTMLElement): void;
	show?(): void;
	hide?(): void;
	destroy?(): void;
}
