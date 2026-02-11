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
}

/**
 * A captured log entry from gg()
 */
export interface CapturedEntry {
	/** Namespace (e.g., "gg:routes/+page.svelte@handleClick") */
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
