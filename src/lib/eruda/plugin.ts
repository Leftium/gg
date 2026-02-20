import type { GgErudaOptions, CapturedEntry } from './types.js';
import { DEV } from 'esm-env';
import { LogBuffer } from './buffer.js';
import {
	Virtualizer,
	elementScroll,
	observeElementOffset,
	observeElementRect,
	measureElement
} from '@tanstack/virtual-core';

/** Compile-time flag set by ggCallSitesPlugin via Vite's `define` config. */
declare const __GG_TAG_PLUGIN__: boolean;
const _ggCallSitesPlugin = typeof __GG_TAG_PLUGIN__ !== 'undefined' ? __GG_TAG_PLUGIN__ : false;

/**
 * Licia jQuery-like wrapper used by Eruda
 */
interface LiciaElement {
	html(content: string): void;
	show(): void;
	hide(): void;
	find(selector: string): LiciaElement;
	on(event: string, handler: (e: Event) => void): void;
	get(index: number): HTMLElement | undefined;
	length: number;
}

/**
 * Creates the gg Eruda plugin
 *
 * Uses Eruda's plugin API where $el is a jQuery-like (licia) wrapper.
 * Methods: $el.html(), $el.show(), $el.hide(), $el.find(), $el.on()
 */
export function createGgPlugin(
	options: GgErudaOptions,
	gg: { _onLog?: ((entry: CapturedEntry) => void) | null }
) {
	const buffer = new LogBuffer(options.maxEntries ?? 2000);
	// The licia jQuery-like wrapper Eruda passes to init()
	let $el: LiciaElement | null = null;
	let expanderAttached = false;
	let resizeAttached = false;
	// null = auto (fit content), number = user-dragged px width
	let nsColWidth: number | null = null;
	// Filter UI state
	let filterExpanded = false;
	let filterPattern = '';
	const enabledNamespaces = new Set<string>();

	// Virtual scroll: filtered indices into the buffer (the "rows" the virtualizer sees)
	let filteredIndices: number[] = [];

	// Virtual scroll: the @tanstack/virtual-core Virtualizer instance
	let virtualizer: Virtualizer<HTMLElement, HTMLElement> | null = null;

	// Virtual scroll: track expanded state so it survives re-renders.
	// Keys are the uniqueId strings (e.g. "42-0") for object details and
	// stack IDs (e.g. "stack-42") for stack traces.
	const expandedDetails = new Set<string>();
	const expandedStacks = new Set<string>();

	// Toast state for "namespace hidden" feedback
	let lastHiddenPattern: string | null = null; // filterPattern before the hide (for undo)
	let hasSeenToastExplanation = false; // first toast auto-expands help text

	// Settings UI state
	let settingsExpanded = false;

	// Expression visibility toggle
	let showExpressions = false;

	// Filter pattern persistence key (independent of localStorage.debug)
	const FILTER_KEY = 'gg-filter';
	const SHOW_EXPRESSIONS_KEY = 'gg-show-expressions';

	// Namespace click action: 'open' uses Vite dev middleware, 'copy' copies formatted string, 'open-url' navigates to URI
	const NS_ACTION_KEY = 'gg-ns-action';
	const EDITOR_BIN_KEY = 'gg-editor-bin';
	const COPY_FORMAT_KEY = 'gg-copy-format';
	const URL_FORMAT_KEY = 'gg-url-format';
	const PROJECT_ROOT_KEY = 'gg-project-root';

	// Render batching: coalesce multiple _onLog calls into a single rAF
	let renderPending = false;
	let pendingEntries: CapturedEntry[] = []; // new entries since last render

	// All namespaces ever seen (maintained incrementally, avoids scanning buffer)
	const allNamespacesSet = new Set<string>();

	// Plugin detection state (probed once at init)
	let openInEditorPluginDetected: boolean | null = null; // null = not yet probed

	// Editor bins for launch-editor (common first, then alphabetical)
	const editorBins: Array<{ label: string; value: string }> = [
		{ label: 'Auto-detect', value: '' },
		{ label: 'VS Code', value: 'code' },
		{ label: 'Cursor', value: 'cursor' },
		{ label: 'Zed', value: 'zed' },
		{ label: 'Sublime Text', value: 'sublime' },
		{ label: 'Vim', value: 'vim' },
		{ label: 'Emacs', value: 'emacs' },
		{ label: 'WebStorm', value: 'webstorm' },
		{ label: 'IDEA', value: 'idea' },
		{ label: 'Atom', value: 'atom' },
		{ label: 'AppCode', value: 'appcode' },
		{ label: 'Brackets', value: 'brackets' },
		{ label: 'CLion', value: 'clion' },
		{ label: 'Code Insiders', value: 'code-insiders' },
		{ label: 'Notepad++', value: 'notepad++' },
		{ label: 'PhpStorm', value: 'phpstorm' },
		{ label: 'PyCharm', value: 'pycharm' },
		{ label: 'Rider', value: 'rider' },
		{ label: 'RubyMine', value: 'rubymine' },
		{ label: 'VSCodium', value: 'codium' },
		{ label: 'Visual Studio', value: 'visualstudio' }
	];

	// Terminal command presets
	const copyPresets: Record<string, string> = {
		'Raw path': '$FILE:$LINE:$COL',
		'VS Code': 'code -g $FILE:$LINE:$COL',
		Cursor: 'cursor -g $FILE:$LINE:$COL',
		Zed: 'zed $FILE:$LINE:$COL',
		Vim: 'vim +$LINE $FILE',
		Emacs: 'emacs +$LINE:$COL $FILE',
		JetBrains: 'idea --line $LINE --column $COL $FILE'
	};

	// URI scheme presets (use $ROOT for absolute paths)
	const uriPresets: Record<string, string> = {
		'VS Code': 'vscode://file/$ROOT/$FILE:$LINE:$COL',
		'VS Code Insiders': 'vscode-insiders://file/$ROOT/$FILE:$LINE:$COL',
		Cursor: 'cursor://file/$ROOT/$FILE:$LINE:$COL',
		Windsurf: 'windsurf://file/$ROOT/$FILE:$LINE:$COL',
		VSCodium: 'vscodium://file/$ROOT/$FILE:$LINE:$COL',
		Zed: 'zed://file/$ROOT/$FILE:$LINE:$COL',
		JetBrains: 'jetbrains://open?file=$ROOT/$FILE&line=$LINE&column=$COL',
		'Sublime Text': 'subl://open?url=file://$ROOT/$FILE&line=$LINE&column=$COL',
		Emacs: 'org-protocol://open-source?url=file://$ROOT/$FILE&line=$LINE&col=$COL',
		Atom: 'atom://open?url=file://$ROOT/$FILE&line=$LINE&column=$COL'
	};

	type NsClickAction = 'open' | 'copy' | 'open-url';
	let nsClickAction: NsClickAction =
		(localStorage.getItem(NS_ACTION_KEY) as NsClickAction) || (DEV ? 'open' : 'copy');
	let editorBin = localStorage.getItem(EDITOR_BIN_KEY) || '';
	let copyFormat = localStorage.getItem(COPY_FORMAT_KEY) || copyPresets['Raw path'];
	let urlFormat = localStorage.getItem(URL_FORMAT_KEY) || uriPresets['VS Code'];
	let projectRoot = localStorage.getItem(PROJECT_ROOT_KEY) || '';

	/** Get the active format string for the current action mode */
	function activeFormat(): string {
		return nsClickAction === 'open-url' ? urlFormat : copyFormat;
	}

	/** Set the active format string and persist it */
	function setActiveFormat(value: string) {
		if (nsClickAction === 'open-url') {
			urlFormat = value;
			localStorage.setItem(URL_FORMAT_KEY, urlFormat);
		} else {
			copyFormat = value;
			localStorage.setItem(COPY_FORMAT_KEY, copyFormat);
		}
	}

	/**
	 * Format a single log entry for clipboard copy
	 * Produces: HH:MM:SS.mmm namespace args [optional expression]
	 */
	function formatEntryForClipboard(entry: CapturedEntry, includeExpressions: boolean): string {
		// Extract HH:MM:SS.mmm from timestamp (with milliseconds)
		const time = new Date(entry.timestamp).toISOString().slice(11, 23);
		// Trim namespace and strip 'gg:' prefix to save tokens
		const ns = entry.namespace.trim().replace(/^gg:/, '');
		// Include expression on its own line above the value when toggle is enabled
		const hasSrcExpr = !entry.level && entry.src?.trim() && !/^['"`]/.test(entry.src);
		const exprLine = includeExpressions && hasSrcExpr ? `\u2039${entry.src}\u203A\n` : '';
		// Format args: compact JSON for objects, primitives as-is
		const argsStr = entry.args
			.map((arg) => {
				if (typeof arg === 'object' && arg !== null) {
					return JSON.stringify(arg);
				}
				// Strip ANSI escape codes from string args
				return stripAnsi(String(arg));
			})
			.join(' ');
		return `${exprLine}${time} ${ns} ${argsStr}`;
	}

	const plugin = {
		name: 'GG',

		init($container: LiciaElement) {
			$el = $container;

			// Load filter state BEFORE registering _onLog hook, because setting _onLog
			// triggers replay of earlyLogBuffer and each entry checks filterPattern
			filterPattern = localStorage.getItem(FILTER_KEY) || 'gg:*';
			showExpressions = localStorage.getItem(SHOW_EXPRESSIONS_KEY) === 'true';

			// Register the capture hook on gg
			if (gg) {
				gg._onLog = (entry: CapturedEntry) => {
					// Track namespaces incrementally (O(1) instead of scanning buffer)
					const isNewNamespace = !allNamespacesSet.has(entry.namespace);
					allNamespacesSet.add(entry.namespace);
					buffer.push(entry);
					// Add new namespace to enabledNamespaces if it matches the current pattern
					const effectivePattern = filterPattern || 'gg:*';
					if (namespaceMatchesPattern(entry.namespace, effectivePattern)) {
						enabledNamespaces.add(entry.namespace);
					}
					// Update filter UI if new namespace appeared (updates button summary count)
					if (isNewNamespace) {
						renderFilterUI();
					}
					// Batch: collect pending entries, schedule one render per frame
					pendingEntries.push(entry);
					if (!renderPending) {
						renderPending = true;
						requestAnimationFrame(() => {
							renderPending = false;
							const batch = pendingEntries;
							pendingEntries = [];
							appendLogs(batch);
						});
					}
				};
			}

			// Probe for openInEditorPlugin (status 222) and auto-populate $ROOT in dev mode
			if (DEV) {
				fetch('/__open-in-editor?file=+')
					.then((r) => {
						openInEditorPluginDetected = r.status === 222;
						// If plugin detected, fetch project root for $ROOT variable
						if (openInEditorPluginDetected && !projectRoot) {
							return fetch('/__gg-project-root').then((r) => r.text());
						}
					})
					.then((root) => {
						if (root) {
							projectRoot = root.trim();
							localStorage.setItem(PROJECT_ROOT_KEY, projectRoot);
						}
						// Re-render settings if panel is open (to show detection result)
						if (settingsExpanded) renderSettingsUI();
					})
					.catch(() => {
						openInEditorPluginDetected = false;
					});
			}

			// Render initial UI
			$el.html(buildHTML());
			wireUpButtons();
			wireUpExpanders();
			wireUpResize();
			wireUpFilterUI();
			wireUpSettingsUI();
			wireUpToast();
			// Discard any entries queued during early-buffer replay (before the DOM
			// existed). renderLogs() below will do a full render from buffer, so the
			// pending rAF batch would only duplicate those entries.
			pendingEntries = [];
			renderPending = false;
			renderLogs();
		},

		show() {
			if ($el) {
				$el.show();
				renderLogs();
			}
		},

		hide() {
			if ($el) {
				$el.hide();
			}
		},

		destroy() {
			if (gg) {
				gg._onLog = null;
			}
			// Clean up virtualizer
			if (virtualizer && $el) {
				const containerDom = $el.find('.gg-log-container').get(0) as HTMLElement | undefined;
				if (containerDom) {
					const cleanup = (containerDom as any).__ggVirtualCleanup;
					if (cleanup) cleanup();
				}
				virtualizer = null;
			}
			buffer.clear();
			allNamespacesSet.clear();
			filteredIndices = [];
		}
	};

	function toggleNamespace(namespace: string, enable: boolean) {
		const currentPattern = filterPattern || 'gg:*';
		const ns = namespace.trim();
		// Split into parts, manipulate, rejoin (avoids fragile regex on complex namespace strings)
		const parts = currentPattern
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean);

		if (enable) {
			// Remove any exclusion for this namespace
			const filtered = parts.filter((p) => p !== `-${ns}`);
			filterPattern = filtered.join(',');
		} else {
			// Add exclusion
			parts.push(`-${ns}`);
			filterPattern = parts.join(',');
		}

		// Simplify pattern
		filterPattern = simplifyPattern(filterPattern);

		// Sync enabledNamespaces from the NEW pattern (don't re-read localStorage)
		const allNamespaces = getAllCapturedNamespaces();
		enabledNamespaces.clear();
		const effectivePattern = filterPattern || 'gg:*';
		allNamespaces.forEach((ns) => {
			if (namespaceMatchesPattern(ns, effectivePattern)) {
				enabledNamespaces.add(ns);
			}
		});
	}

	function toggleNamespaces(namespaces: string[], enable: boolean) {
		const currentPattern = filterPattern || 'gg:*';
		let parts = currentPattern
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean);

		namespaces.forEach((namespace) => {
			const ns = namespace.trim();
			if (enable) {
				// Remove any exclusion for this namespace
				parts = parts.filter((p) => p !== `-${ns}`);
			} else {
				// Add exclusion if not already present
				const exclusion = `-${ns}`;
				if (!parts.includes(exclusion)) {
					parts.push(exclusion);
				}
			}
		});

		filterPattern = parts.join(',');

		// Simplify pattern
		filterPattern = simplifyPattern(filterPattern);

		// Sync enabledNamespaces from the NEW pattern
		const allNamespaces = getAllCapturedNamespaces();
		enabledNamespaces.clear();
		const effectivePattern = filterPattern || 'gg:*';
		allNamespaces.forEach((ns) => {
			if (namespaceMatchesPattern(ns, effectivePattern)) {
				enabledNamespaces.add(ns);
			}
		});

		// Persist the new pattern
		localStorage.setItem(FILTER_KEY, filterPattern);
	}

	function simplifyPattern(pattern: string): string {
		if (!pattern) return '';

		// Remove empty parts
		let parts = pattern
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean);

		// Remove duplicates
		parts = Array.from(new Set(parts));

		// Clean up trailing/leading commas
		return parts.join(',');
	}

	function getAllCapturedNamespaces(): string[] {
		return Array.from(allNamespacesSet).sort();
	}

	function namespaceMatchesPattern(namespace: string, pattern: string): boolean {
		if (!pattern) return true; // Empty pattern = show all

		// Split by comma for OR logic
		const parts = pattern.split(',').map((p) => p.trim());
		let included = false;
		let excluded = false;

		for (const part of parts) {
			if (part.startsWith('-')) {
				// Exclusion pattern
				const excludePattern = part.slice(1);
				if (matchesGlob(namespace, excludePattern)) {
					excluded = true;
				}
			} else {
				// Inclusion pattern
				if (matchesGlob(namespace, part)) {
					included = true;
				}
			}
		}

		// If no inclusion patterns, default to included
		const hasInclusions = parts.some((p) => !p.startsWith('-'));
		if (!hasInclusions) included = true;

		return included && !excluded;
	}

	function matchesGlob(str: string, pattern: string): boolean {
		// Trim both for comparison (namespaces may have trailing spaces from padEnd)
		const s = str.trim();
		const p = pattern.trim();

		// Convert glob pattern to regex
		const regexPattern = p
			.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
			.replace(/\*/g, '.*'); // * becomes .*
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(s);
	}

	function isSimplePattern(pattern: string): boolean {
		if (!pattern) return true;

		// Simple patterns:
		// 1. 'gg:*' with optional exclusions
		// 2. Explicit comma-separated list of exact namespaces

		const parts = pattern.split(',').map((p) => p.trim());

		// Check if it's 'gg:*' based (with exclusions)
		const hasWildcardBase = parts.some((p) => p === 'gg:*' || p === '*');
		if (hasWildcardBase) {
			// All other parts must be exclusions starting with '-gg:'
			const otherParts = parts.filter((p) => p !== 'gg:*' && p !== '*');
			return otherParts.every((p) => p.startsWith('-') && !p.includes('*', 1));
		}

		// Check if it's an explicit list (no wildcards)
		return parts.every((p) => !p.includes('*') && !p.startsWith('-'));
	}

	function gridColumns(): string {
		const ns = nsColWidth !== null ? `${nsColWidth}px` : 'auto';
		// Grid columns: diff | ns | handle | content
		// Diff uses a fixed width (3.5em) instead of auto to avoid column jitter
		// when virtual scroll swaps rows in/out — only ~50 rows are in the DOM
		// at a time so auto would resize based on visible subset.
		return `3.5em ${ns} 4px 1fr`;
	}

	function buildHTML(): string {
		return `
			<style>
			.gg-log-grid {
				display: grid;
				grid-template-columns: ${gridColumns()};
				column-gap: 0;
				align-items: start !important;
			}
			/* Virtual scroll: each entry is a subgrid row with measurable height */
			.gg-log-entry {
				display: grid;
				grid-template-columns: subgrid;
				grid-column: 1 / -1;
			}
		.gg-log-header {
			display: contents;
		}
		.gg-log-diff,
		.gg-log-ns,
		.gg-log-handle,
		.gg-log-content {
			min-width: 0;
			align-self: start !important;
			border-top: 1px solid rgba(0,0,0,0.05);
		}
		/* Virtual scroll: spacer provides total height for scrollbar */
		.gg-virtual-spacer {
			position: relative;
			width: 100%;
		}
	.gg-reset-filter-btn:hover {
		background: #1976D2 !important;
		transform: translateY(-1px);
		box-shadow: 0 2px 8px rgba(33, 150, 243, 0.4);
	}
	.gg-reset-filter-btn:active {
		transform: translateY(0);
	}
		/* Clickable time diff with file metadata (open-in-editor) */
		.gg-log-diff[data-file] {
			cursor: pointer;
			text-decoration: underline;
			text-decoration-style: dotted;
			text-underline-offset: 2px;
			opacity: 0.85;
		}
		.gg-log-diff[data-file]:hover {
			text-decoration-style: solid;
			opacity: 1;
			background: rgba(0,0,0,0.05);
		}
	/* Clickable namespace segments - always enabled for filtering */
		.gg-ns-segment {
			cursor: pointer;
			padding: 1px 2px;
			border-radius: 2px;
			transition: background 0.1s;
		}
		.gg-ns-segment:hover {
			background: rgba(0,0,0,0.1);
			text-decoration: underline;
			text-decoration-style: solid;
			text-underline-offset: 2px;
		}
			.gg-details {
				grid-column: 1 / -1;
				border-top: none;
			}
				.gg-details {
					align-self: stretch !important;
					border-bottom: none;
				}
				.gg-log-diff {
					text-align: right;
					padding: 4px 8px 4px 0;
					white-space: pre;
				}
		.gg-log-ns {
			font-weight: bold;
			white-space: nowrap;
			overflow: hidden;
			padding: 4px 8px 4px 0;
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.gg-ns-text {
			overflow: hidden;
			text-overflow: ellipsis;
			min-width: 0;
		}
	.gg-ns-hide {
		all: unset;
		cursor: pointer;
		opacity: 0;
		font-size: 14px;
		font-weight: bold;
		line-height: 1;
		padding: 1px 4px;
		transition: opacity 0.15s;
		flex-shrink: 0;
	}
		.gg-log-ns:hover .gg-ns-hide {
			opacity: 0.4;
		}
		.gg-ns-hide:hover {
			opacity: 1 !important;
			background: rgba(0,0,0,0.08);
			border-radius: 3px;
		}
	/* Toast bar for "namespace hidden" feedback */
	.gg-toast {
		display: none;
		background: #333;
		color: #e0e0e0;
		font-size: 12px;
		font-family: monospace;
		padding: 8px 12px;
		border-radius: 6px 6px 0 0;
		flex-shrink: 0;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
		animation: gg-toast-slide-up 0.2s ease-out;
	}
	.gg-toast.visible {
		display: flex;
		flex-wrap: wrap;
	}
	@keyframes gg-toast-slide-up {
		from { transform: translateY(100%); opacity: 0; }
		to { transform: translateY(0); opacity: 1; }
	}
	.gg-toast-label {
		opacity: 0.7;
		flex-shrink: 0;
	}
	.gg-toast-ns {
		display: inline-flex;
		align-items: center;
		gap: 0;
	}
	.gg-toast-segment {
		cursor: pointer;
		padding: 1px 3px;
		border-radius: 2px;
		color: #bbb;
		text-decoration: line-through;
		transition: background 0.1s, color 0.1s;
	}
	.gg-toast-segment:hover {
		color: #ef5350;
		background: rgba(239, 83, 80, 0.15);
	}
	.gg-toast-delim {
		opacity: 0.5;
	}
	.gg-toast-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-left: auto;
		flex-shrink: 0;
	}
	.gg-toast-btn {
		all: unset;
		cursor: pointer;
		padding: 2px 8px;
		border-radius: 3px;
		font-size: 11px;
		transition: background 0.1s;
	}
	.gg-toast-undo {
		color: #64b5f6;
		font-weight: bold;
	}
	.gg-toast-undo:hover {
		background: rgba(100, 181, 246, 0.2);
	}
	.gg-toast-help {
		color: #999;
		font-size: 13px;
		line-height: 1;
	}
	.gg-toast-help:hover {
		color: #ccc;
		background: rgba(255,255,255,0.1);
	}
	.gg-toast-dismiss {
		color: #999;
		font-size: 14px;
		line-height: 1;
	}
	.gg-toast-dismiss:hover {
		color: #fff;
		background: rgba(255,255,255,0.1);
	}
	.gg-toast-explanation {
		display: none;
		width: 100%;
		font-size: 11px;
		opacity: 0.6;
		padding-top: 4px;
		margin-top: 4px;
		border-top: 1px solid rgba(255,255,255,0.1);
	}
	.gg-toast-explanation.visible {
		display: block;
	}
				.gg-log-handle {
					width: 4px;
					cursor: col-resize;
					align-self: stretch !important;
					background: transparent;
					position: relative;
					padding: 0 8px 0 0;
				}
				/* Wider invisible hit area */
				.gg-log-handle::before {
					content: '';
					position: absolute;
					top: 0; bottom: 0;
					left: -4px; right: -4px;
				}
				.gg-log-handle:hover,
				.gg-log-handle.gg-dragging {
					background: rgba(0,0,0,0.15);
				}
			.gg-log-content {
				word-break: break-word;
				padding: 4px 0;
				position: relative;
				-webkit-user-select: text !important;
				user-select: text !important;
				cursor: text;
			}
				.gg-log-content * {
					-webkit-user-select: text !important;
					user-select: text !important;
				}
				.gg-log-diff, .gg-log-ns {
					-webkit-user-select: text !important;
					user-select: text !important;
				}
				.gg-details, .gg-details * {
					-webkit-user-select: text !important;
					user-select: text !important;
					cursor: text;
				}
				/* Fast custom tooltip for src expression on primitive-only rows (no expandable objects) */
				.gg-log-content[data-src] {
					cursor: help;
				}
				/* Show icon only on primitive rows (no .gg-expand child) */
				.gg-log-content[data-src]:not(:has(.gg-expand))::before {
					content: '\uD83D\uDD0D';
					font-size: 10px;
					margin-right: 4px;
					opacity: 0.4;
				}
				.gg-log-content[data-src]:not(:has(.gg-expand)):hover::before {
					opacity: 1;
				}
				.gg-log-content[data-src]:not(:has(.gg-expand))::after {
					content: attr(data-src);
					position: absolute;
					top: 100%;
					left: 0;
					background: #333;
					color: #fff;
					font-size: 11px;
					font-family: monospace;
					padding: 3px 8px;
					border-radius: 3px;
					white-space: nowrap;
					pointer-events: none;
					opacity: 0;
					transition: opacity 0.1s;
					z-index: 1000;
					max-width: 90vw;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.gg-log-content[data-src]:not(:has(.gg-expand)):hover::after {
					opacity: 1;
				}
				/* Inline expression label (shown when expression toggle is on) */
				.gg-inline-expr {
					color: #888;
					font-style: italic;
					font-size: 11px;
				}
				/* When expressions are shown inline, suppress the CSS tooltip and magnifying glass on primitives */
				.gg-show-expr .gg-log-content[data-src] {
					cursor: text;
				}
				.gg-show-expr .gg-log-content[data-src]:not(:has(.gg-expand))::before,
				.gg-show-expr .gg-log-content[data-src]:not(:has(.gg-expand))::after {
					display: none;
				}
				/* Expression icon inline with expandable object labels */
				.gg-src-icon {
					font-size: 10px;
					margin-right: 2px;
					opacity: 0.4;
					cursor: pointer;
				}
				.gg-expand:hover .gg-src-icon,
				.gg-src-icon:hover {
					opacity: 1;
				}
				/* Hover tooltip for expandable objects/arrays */
				.gg-hover-tooltip {
					display: none;
					position: fixed;
					background: #1e1e1e;
					color: #d4d4d4;
					font-size: 11px;
					font-family: monospace;
					padding: 8px 10px;
					border-radius: 4px;
					white-space: pre;
					pointer-events: none;
					z-index: 100000;
					max-width: min(90vw, 500px);
					max-height: 300px;
					overflow: auto;
					box-shadow: 0 2px 8px rgba(0,0,0,0.3);
					line-height: 1.4;
				}
				.gg-hover-tooltip-src {
					color: #9cdcfe;
					font-style: italic;
					margin-bottom: 4px;
					padding-bottom: 4px;
					border-bottom: 1px solid #444;
				}
				/* Expression header inside expanded details */
				.gg-details-src {
					color: #555;
					font-style: italic;
					font-family: monospace;
					font-size: 11px;
					margin-bottom: 6px;
					padding-bottom: 4px;
					border-bottom: 1px solid #ddd;
				}
				/* Level-based styling for info/warn/error entries */
				.gg-level-info .gg-log-diff,
				.gg-level-info .gg-log-ns,
				.gg-level-info .gg-log-content {
					background: rgba(23, 162, 184, 0.08);
				}
				.gg-level-info .gg-log-content {
					border-left: 3px solid #17a2b8;
					padding-left: 6px;
				}
				.gg-level-warn .gg-log-diff,
				.gg-level-warn .gg-log-ns,
				.gg-level-warn .gg-log-content {
					background: rgba(255, 200, 0, 0.08);
				}
				.gg-level-warn .gg-log-content {
					border-left: 3px solid #e6a700;
					padding-left: 6px;
				}
				.gg-level-error .gg-log-diff,
				.gg-level-error .gg-log-ns,
				.gg-level-error .gg-log-content {
					background: rgba(255, 50, 50, 0.08);
				}
				.gg-level-error .gg-log-content {
					border-left: 3px solid #cc0000;
					padding-left: 6px;
				}
				/* Stack trace toggle */
				.gg-stack-toggle {
					cursor: pointer;
					font-size: 11px;
					opacity: 0.6;
					margin-left: 8px;
					user-select: none;
				}
				.gg-stack-toggle:hover {
					opacity: 1;
				}
				.gg-stack-content {
					display: none;
					font-size: 11px;
					font-family: monospace;
					white-space: pre;
					padding: 6px 8px;
					margin-top: 4px;
					background: #f0f0f0;
					border-radius: 3px;
					overflow-x: auto;
					color: #666;
					line-height: 1.4;
				}
				.gg-stack-content.expanded {
					display: block;
				}
			.gg-filter-panel {
					background: #f5f5f5;
					padding: 10px;
					margin-bottom: 8px;
					border-radius: 4px;
					flex-shrink: 0;
					display: none;
				}
				.gg-filter-panel.expanded {
					display: block;
				}
				.gg-filter-pattern {
					width: 100%;
					padding: 4px 8px;
					font-family: monospace;
					font-size: 16px;
					margin-bottom: 8px;
				}
				.gg-filter-checkboxes {
					display: flex;
					flex-wrap: wrap;
					gap: 8px;
					margin: 8px 0;
					max-height: 100px;
					overflow-y: auto;
				}
			.gg-filter-checkbox {
				display: flex;
				align-items: center;
				gap: 4px;
				font-size: 11px;
				font-family: monospace;
				white-space: nowrap;
			}
			.gg-settings-panel {
				background: #f5f5f5;
				padding: 10px;
				margin-bottom: 8px;
				border-radius: 4px;
				flex-shrink: 0;
				display: none;
			}
			.gg-settings-panel.expanded {
				display: block;
			}
			.gg-settings-label {
				font-size: 11px;
				font-weight: bold;
				margin-bottom: 4px;
			}
			.gg-editor-format-input,
			.gg-project-root-input {
				width: 100%;
				padding: 4px 8px;
				font-family: monospace;
				font-size: 14px;
				margin-bottom: 8px;
				box-sizing: border-box;
			}
			.gg-editor-presets {
				display: flex;
				flex-wrap: wrap;
				gap: 4px;
			}
			.gg-editor-presets button {
				padding: 2px 8px;
				font-size: 11px;
				cursor: pointer;
				border: 1px solid #ccc;
				border-radius: 3px;
				background: #fff;
			}
			.gg-editor-presets button.active {
				background: #4a9eff;
				color: #fff;
				border-color: #4a9eff;
			}
			.gg-editor-presets button:hover {
				background: #e0e0e0;
			}
			.gg-editor-presets button.active:hover {
				background: #3a8eef;
			}
			.gg-settings-radios {
				display: flex;
				flex-wrap: wrap;
				gap: 4px 12px;
				margin-bottom: 8px;
			}
			.gg-settings-radios label {
				font-size: 12px;
				padding: 3px 0;
				cursor: pointer;
				white-space: nowrap;
			}
			.gg-settings-radios label.disabled {
				opacity: 0.4;
				cursor: not-allowed;
			}
			.gg-settings-sub {
				margin-top: 4px;
				margin-bottom: 8px;
			}
			.gg-settings-sub select {
				padding: 2px 4px;
				font-size: 12px;
			}
			/* Mobile responsive styles */
				.gg-toolbar {
					display: flex;
					align-items: center;
					gap: 8px;
					margin-bottom: 8px;
					flex-shrink: 0;
					overflow-x: auto;
					-webkit-overflow-scrolling: touch;
				}
				.gg-toolbar button {
					padding: 4px 10px;
					cursor: pointer;
					flex-shrink: 0;
				}
				.gg-btn-text {
					display: inline;
				}
				.gg-btn-icon {
					display: none;
				}
				@media (max-width: 640px) {
					.gg-btn-text {
						display: none;
					}
					.gg-btn-icon {
						display: inline;
					}
					.gg-toolbar button {
						padding: 4px 8px;
						min-width: 32px;
					}
					.gg-filter-btn {
						font-family: monospace;
						font-size: 12px;
					}
					/* Stack log entries vertically on mobile */
					.gg-log-grid {
						display: block;
					}
					.gg-log-entry {
						display: block;
						padding: 8px 0;
					}
				/* Remove double borders on mobile - only border on entry wrapper */
				.gg-log-entry:not(:first-child) {
					border-top: 1px solid rgba(0,0,0,0.05);
				}
			.gg-log-diff,
			.gg-log-ns,
			.gg-log-handle,
			.gg-log-content,
			.gg-details {
				border-top: none !important;
			}
			.gg-log-header {
				display: flex;
				align-items: center;
				gap: 8px;
				margin-bottom: 4px;
				min-width: 0;
			}
				.gg-log-diff {
					padding: 0;
					text-align: left;
					flex-shrink: 0;
					white-space: nowrap;
				}
				.gg-log-ns {
					padding: 0;
					flex: 1;
					min-width: 0;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.gg-log-handle {
					display: none;
				}
				.gg-log-content {
					padding: 0;
					padding-left: 0;
				}
					.gg-details {
						margin-top: 4px;
					}
				}
			</style>
		<div class="eruda-gg${nsClickAction === 'open' || nsClickAction === 'open-url' ? ' gg-action-open' : ''}" style="padding: 10px; height: 100%; display: flex; flex-direction: column; font-size: 14px; touch-action: none; overscroll-behavior: contain;">
			<div class="gg-toolbar">
				<button class="gg-copy-btn">
					<span class="gg-btn-text">📋 <span class="gg-copy-count">Copy 0 entries</span></span>
					<span class="gg-btn-icon" title="Copy">📋</span>
				</button>
			<button class="gg-filter-btn" style="text-align: left; white-space: nowrap;">
				<span class="gg-btn-text">Namespaces: </span>
				<span class="gg-btn-icon">NS: </span>
				<span class="gg-filter-summary"></span>
			</button>
			<button class="gg-expressions-btn" style="background: ${showExpressions ? '#e8f5e9' : 'transparent'};" title="Toggle expression visibility in logs and clipboard">
				<span class="gg-btn-text">\uD83D\uDD0D Expr</span>
				<span class="gg-btn-icon" title="Expressions">\uD83D\uDD0D</span>
			</button>
				<span style="flex: 1;"></span>
				<button class="gg-settings-btn">
					<span class="gg-btn-text">⚙️ Settings</span>
					<span class="gg-btn-icon" title="Settings">⚙️</span>
				</button>
				<button class="gg-clear-btn">
					<span class="gg-btn-text">Clear</span>
					<span class="gg-btn-icon" title="Clear">⊘</span>
				</button>
			</div>
				<div class="gg-filter-panel"></div>
				<div class="gg-settings-panel"></div>
				<div class="gg-truncation-banner" style="display: none; padding: 6px 12px; background: #7f4f00; color: #ffe0a0; font-size: 11px; align-items: center; gap: 6px; flex-shrink: 0;"></div>
				<div class="gg-log-container" style="flex: 1; overflow-y: auto; overflow-x: hidden; font-family: monospace; font-size: 12px; touch-action: pan-y; overscroll-behavior: contain;"></div>
				<div class="gg-toast"></div>
				<iframe class="gg-editor-iframe" hidden title="open-in-editor"></iframe>
			</div>
		`;
	}

	function applyPatternFromInput(value: string) {
		filterPattern = value;
		localStorage.setItem(FILTER_KEY, filterPattern);
		// Sync enabledNamespaces from the new pattern
		const allNamespaces = getAllCapturedNamespaces();
		enabledNamespaces.clear();
		const effectivePattern = filterPattern || 'gg:*';
		allNamespaces.forEach((ns) => {
			if (namespaceMatchesPattern(ns, effectivePattern)) {
				enabledNamespaces.add(ns);
			}
		});
		renderFilterUI();
		renderLogs();
	}

	function wireUpFilterUI() {
		if (!$el) return;

		const filterBtn = $el.find('.gg-filter-btn').get(0) as HTMLElement;
		const filterPanel = $el.find('.gg-filter-panel').get(0) as HTMLElement;
		if (!filterBtn || !filterPanel) return;

		renderFilterUI();

		// Wire up button toggle (close settings if opening filter)
		filterBtn.addEventListener('click', () => {
			filterExpanded = !filterExpanded;
			if (filterExpanded) {
				settingsExpanded = false;
				renderSettingsUI();
			}
			renderFilterUI();
			renderLogs(); // Re-render to update grid columns
		});

		// Wire up pattern input - apply on blur or Enter
		filterPanel.addEventListener(
			'blur',
			(e: FocusEvent) => {
				const target = e.target as HTMLInputElement;
				if (target.classList.contains('gg-filter-pattern')) {
					applyPatternFromInput(target.value);
				}
			},
			true
		); // useCapture for blur (doesn't bubble)

		filterPanel.addEventListener('keydown', (e: KeyboardEvent) => {
			const target = e.target as HTMLInputElement;
			if (target.classList.contains('gg-filter-pattern') && e.key === 'Enter') {
				applyPatternFromInput(target.value);
				target.blur();
			}
		});

		// Wire up checkboxes
		filterPanel.addEventListener('change', (e: Event) => {
			const target = e.target as HTMLInputElement;

			// Handle ALL checkbox
			if (target.classList.contains('gg-all-checkbox')) {
				const allNamespaces = getAllCapturedNamespaces();
				if (target.checked) {
					// Select all
					filterPattern = 'gg:*';
					enabledNamespaces.clear();
					allNamespaces.forEach((ns) => enabledNamespaces.add(ns));
				} else {
					// Deselect all
					const exclusions = allNamespaces.map((ns) => `-${ns}`).join(',');
					filterPattern = `gg:*,${exclusions}`;
					enabledNamespaces.clear();
				}
				localStorage.setItem(FILTER_KEY, filterPattern);
				renderFilterUI();
				renderLogs();
				return;
			}

			// Handle "other" checkbox
			if (target.classList.contains('gg-other-checkbox')) {
				const otherNamespacesJson = target.getAttribute('data-other-namespaces');
				if (!otherNamespacesJson) return;

				const otherNamespaces = JSON.parse(otherNamespacesJson) as string[];

				// Toggle all "other" namespaces at once
				toggleNamespaces(otherNamespaces, target.checked);

				// localStorage already saved in toggleNamespaces()
				renderFilterUI();
				renderLogs();
				return;
			}

			// Handle individual namespace checkboxes
			if (target.classList.contains('gg-ns-checkbox')) {
				const namespace = target.getAttribute('data-namespace');
				if (!namespace) return;

				// Toggle namespace in pattern
				toggleNamespace(namespace, target.checked);

				// Re-render to update UI
				renderFilterUI();
				renderLogs();
			}
		});
	}

	function renderFilterUI() {
		if (!$el) return;

		const allNamespaces = getAllCapturedNamespaces();
		const enabledCount = enabledNamespaces.size;
		const totalCount = allNamespaces.length;

		// Update button summary with count of enabled namespaces
		const filterSummary = $el.find('.gg-filter-summary').get(0) as HTMLElement;
		if (filterSummary) {
			filterSummary.textContent = `${enabledCount}/${totalCount}`;
		}

		// Update panel
		const filterPanel = $el.find('.gg-filter-panel').get(0) as HTMLElement;
		if (!filterPanel) return;

		if (filterExpanded) {
			// Show panel
			filterPanel.classList.add('expanded');

			// Render expanded view
			const allNamespaces = getAllCapturedNamespaces();
			const simple = isSimplePattern(filterPattern);
			const effectivePattern = filterPattern || 'gg:*';

			let checkboxesHTML = '';
			if (simple && allNamespaces.length > 0) {
				const allChecked = enabledCount === totalCount;

				// Count frequency of each namespace in the buffer
				const allEntries = buffer.getEntries();
				const nsCounts = new Map<string, number>();
				allEntries.forEach((entry: CapturedEntry) => {
					nsCounts.set(entry.namespace, (nsCounts.get(entry.namespace) || 0) + 1);
				});

				// Sort ALL namespaces by frequency (most common first)
				const sortedAllNamespaces = [...allNamespaces].sort(
					(a, b) => (nsCounts.get(b) || 0) - (nsCounts.get(a) || 0)
				);

				// Take top 5 most common (regardless of enabled state)
				const displayedNamespaces = sortedAllNamespaces.slice(0, 5);

				// Calculate "other" namespaces (not in top 5)
				const displayedSet = new Set(displayedNamespaces);
				const otherNamespaces = allNamespaces.filter((ns) => !displayedSet.has(ns));
				const otherEnabledCount = otherNamespaces.filter((ns) => enabledNamespaces.has(ns)).length;
				const otherTotalCount = otherNamespaces.length;
				const otherChecked = otherEnabledCount > 0;
				const otherCount = otherNamespaces.reduce((sum, ns) => sum + (nsCounts.get(ns) || 0), 0);

				checkboxesHTML = `
			<div class="gg-filter-checkboxes">
				<label class="gg-filter-checkbox" style="font-weight: bold;">
					<input type="checkbox" class="gg-all-checkbox" ${allChecked ? 'checked' : ''}>
					<span>ALL</span>
				</label>
				${displayedNamespaces
					.map((ns) => {
						// Check if namespace matches the current pattern
						const checked = namespaceMatchesPattern(ns, effectivePattern);
						const count = nsCounts.get(ns) || 0;
						return `
						<label class="gg-filter-checkbox">
							<input type="checkbox" class="gg-ns-checkbox" data-namespace="${escapeHtml(ns)}" ${checked ? 'checked' : ''}>
							<span>${escapeHtml(ns)} (${count})</span>
						</label>
					`;
					})
					.join('')}
				${
					otherTotalCount > 0
						? `
				<label class="gg-filter-checkbox" style="opacity: 0.7;">
					<input type="checkbox" class="gg-other-checkbox" ${otherChecked ? 'checked' : ''} data-other-namespaces='${JSON.stringify(otherNamespaces)}'>
					<span>other (${otherCount})</span>
				</label>
				`
						: ''
				}
			</div>
		`;
			} else if (!simple) {
				checkboxesHTML = `<div style="opacity: 0.6; font-size: 11px; margin: 8px 0;">⚠️ Complex pattern - edit manually (quick filters disabled)</div>`;
			}

			filterPanel.innerHTML = `
			<div style="margin-bottom: 8px;">
				<input type="text" class="gg-filter-pattern" value="${escapeHtml(filterPattern)}" placeholder="gg:*" style="width: 100%;">
			</div>
			${checkboxesHTML}
		`;
		} else {
			// Hide panel
			filterPanel.classList.remove('expanded');
		}
	}

	/** Render the format field + $ROOT field shared by "Copy to clipboard" and "Open as URL" */
	function renderFormatSection(isUrlMode: boolean): string {
		const presets = isUrlMode ? uriPresets : copyPresets;
		const placeholder = isUrlMode ? 'vscode://file/$ROOT/$FILE:$LINE:$COL' : '$FILE:$LINE:$COL';
		const description = isUrlMode
			? 'Opens a URI in the browser. Editor apps register URI schemes to handle these.'
			: 'Copies a command to your clipboard. Paste in a terminal to open the source file.';

		const currentFormat = activeFormat();
		const presetButtons = Object.entries(presets)
			.map(([name, fmt]) => {
				const active = currentFormat === fmt ? ' active' : '';
				return `<button class="gg-preset-btn${active}" data-format="${escapeHtml(fmt)}">${escapeHtml(name)}</button>`;
			})
			.join('');

		return `
			<div class="gg-settings-sub">
				<div style="font-size: 11px; opacity: 0.7; margin-bottom: 6px;">${description}<br>Variables: <code>$FILE</code>, <code>$LINE</code>, <code>$COL</code>, <code>$ROOT</code></div>
				<input type="text" class="gg-editor-format-input" value="${escapeHtml(currentFormat)}" placeholder="${escapeHtml(placeholder)}">
				<div class="gg-settings-label" style="margin-top: 4px;">Presets:</div>
				<div class="gg-editor-presets">${presetButtons}</div>
				<div style="margin-top: 8px;">
					<div class="gg-settings-label">Project root (<code>$ROOT</code>):</div>
					<input type="text" class="gg-project-root-input" value="${escapeHtml(projectRoot)}" placeholder="/home/user/my-project" style="width: 100%; padding: 4px 8px; font-family: monospace; font-size: 14px; box-sizing: border-box;">
					<div style="font-size: 10px; opacity: 0.5; margin-top: 2px;">${DEV && openInEditorPluginDetected ? 'Auto-filled from dev server.' : 'Set manually for URI schemes.'} Uses forward slashes on all platforms.</div>
				</div>
			</div>
		`;
	}

	function renderSettingsUI() {
		if (!$el) return;

		const settingsPanel = $el.find('.gg-settings-panel').get(0) as HTMLElement;
		if (!settingsPanel) return;

		// Toggle CSS class on container for hover icon (📝 vs 📋)
		const container = $el.find('.eruda-gg').get(0) as HTMLElement;
		if (container) {
			container.classList.toggle(
				'gg-action-open',
				nsClickAction === 'open' || nsClickAction === 'open-url'
			);
		}

		if (settingsExpanded) {
			settingsPanel.classList.add('expanded');

			const openDisabled = !DEV;
			const openLabelClass = openDisabled ? ' disabled' : '';

			// Warning when call-sites plugin not installed (no file/line/col metadata)
			const callSitesWarning = !_ggCallSitesPlugin
				? `<div style="font-size: 11px; color: #b8860b; margin-bottom: 6px;">\u26A0 call-sites vite plugin not detected \u2014 namespaces have no file locations. Add ggCallSitesPlugin() to vite.config.ts to enable click-to-open.</div>`
				: '';

			// Options section below all radios (editor buttons or format field)
			let optionsSection = '';
			if (nsClickAction === 'open' && !openDisabled) {
				const pluginWarning =
					openInEditorPluginDetected === false
						? `<div style="font-size: 11px; color: #b8860b; margin-bottom: 6px;">\u26A0 open-in-editor vite plugin not detected \u2014 file will open at line 1 (no cursor positioning or editor selection). Add openInEditorPlugin() to vite.config.ts for full support.</div>`
						: '';
				let editorButtons = '';
				if (openInEditorPluginDetected !== false) {
					const buttons = editorBins
						.map(({ label, value }) => {
							const active = value === editorBin ? ' active' : '';
							return `<button class="gg-editor-bin-btn${active}" data-editor="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
						})
						.join('');
					editorButtons = `<div class="gg-settings-label">Editor:</div><div class="gg-editor-presets">${buttons}</div>`;
				}
				optionsSection = `<div class="gg-settings-sub">${pluginWarning}${editorButtons}</div>`;
			} else if (nsClickAction === 'copy' || nsClickAction === 'open-url') {
				optionsSection = renderFormatSection(nsClickAction === 'open-url');
			}

			// Native Console section
			const currentDebugValue = localStorage.getItem('debug');
			const debugDisplay =
				currentDebugValue !== null ? `'${escapeHtml(currentDebugValue)}'` : 'not set';
			const currentFilter = filterPattern || 'gg:*';
			const debugMatchesFilter = currentDebugValue === currentFilter;
			const debugIncludesGg =
				currentDebugValue !== null &&
				(currentDebugValue.includes('gg:') || currentDebugValue === '*');

			const nativeConsoleSection = `
				<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #ddd;">
					<div class="gg-settings-label">Native Console Output</div>
					<div style="font-size: 11px; opacity: 0.7; margin-bottom: 8px;">
						gg messages always appear in this GG panel. To also see them in the browser's native console, set <code>localStorage.debug</code> below.
						For server-side: <code>DEBUG=gg:* npm run dev</code>
					</div>
					<div style="font-family: monospace; font-size: 12px; margin-bottom: 6px;">
						localStorage.debug = ${debugDisplay}
						${debugIncludesGg ? '<span style="color: green;">✅</span>' : '<span style="color: #999;">⚫ gg:* not included</span>'}
					</div>
					<div style="display: flex; gap: 6px; flex-wrap: wrap;">
						<button class="gg-sync-debug-btn" style="padding: 4px 10px; font-size: 12px; cursor: pointer; border: 1px solid #ccc; border-radius: 3px; background: ${debugMatchesFilter ? '#e8e8e8' : '#fff'};"${debugMatchesFilter ? ' disabled' : ''}>
							${debugMatchesFilter ? 'In sync' : `Set to '${escapeHtml(currentFilter)}'`}
						</button>
						<button class="gg-clear-debug-btn" style="padding: 4px 10px; font-size: 12px; cursor: pointer; border: 1px solid #ccc; border-radius: 3px; background: #fff;"${currentDebugValue === null ? ' disabled' : ''}>
							Clear
						</button>
					</div>
					<div style="font-size: 10px; opacity: 0.5; margin-top: 4px;">
						Changes take effect on next page reload.
					</div>
				</div>
			`;

			settingsPanel.innerHTML = `
				${callSitesWarning}
				<div class="gg-settings-label">When namespace clicked:</div>
				<div class="gg-settings-radios">
					<label class="${openLabelClass}">
						<input type="radio" name="gg-ns-action" value="open" ${nsClickAction === 'open' ? 'checked' : ''} ${openDisabled ? 'disabled' : ''}>
						Open via dev server${openDisabled ? ' (dev mode only)' : ''}
					</label>
					<label>
						<input type="radio" name="gg-ns-action" value="open-url" ${nsClickAction === 'open-url' ? 'checked' : ''}>
						Open via URL
					</label>
					<label>
						<input type="radio" name="gg-ns-action" value="copy" ${nsClickAction === 'copy' ? 'checked' : ''}>
						Copy to clipboard
					</label>
				</div>
				${optionsSection}
				${nativeConsoleSection}
			`;
		} else {
			settingsPanel.classList.remove('expanded');
		}
	}

	function wireUpSettingsUI() {
		if (!$el) return;

		const settingsBtn = $el.find('.gg-settings-btn').get(0) as HTMLElement;
		const settingsPanel = $el.find('.gg-settings-panel').get(0) as HTMLElement;
		if (!settingsBtn || !settingsPanel) return;

		// Toggle settings panel (close filter if opening settings)
		settingsBtn.addEventListener('click', () => {
			settingsExpanded = !settingsExpanded;
			if (settingsExpanded) {
				filterExpanded = false;
				renderFilterUI();
				renderLogs();
			}
			renderSettingsUI();
		});

		// Event delegation on settings panel
		settingsPanel.addEventListener('change', (e: Event) => {
			const target = e.target as HTMLInputElement | HTMLSelectElement;

			// Radio buttons: open vs copy vs open-url
			if (target.name === 'gg-ns-action') {
				nsClickAction = target.value as NsClickAction;
				localStorage.setItem(NS_ACTION_KEY, nsClickAction);
				renderSettingsUI();
				renderLogs(); // Re-render tooltips
			}
		});

		// Format + project root inputs: apply on blur or Enter
		settingsPanel.addEventListener(
			'blur',
			(e: FocusEvent) => {
				const target = e.target as HTMLInputElement;
				if (target.classList.contains('gg-editor-format-input')) {
					setActiveFormat(target.value);
					renderSettingsUI();
				}
				if (target.classList.contains('gg-project-root-input')) {
					projectRoot = target.value;
					localStorage.setItem(PROJECT_ROOT_KEY, projectRoot);
				}
			},
			true
		);

		settingsPanel.addEventListener('keydown', (e: KeyboardEvent) => {
			const target = e.target as HTMLInputElement;
			if (target.classList.contains('gg-editor-format-input') && e.key === 'Enter') {
				setActiveFormat(target.value);
				target.blur();
				renderSettingsUI();
			}
			if (target.classList.contains('gg-project-root-input') && e.key === 'Enter') {
				projectRoot = target.value;
				localStorage.setItem(PROJECT_ROOT_KEY, projectRoot);
				target.blur();
			}
		});

		// Preset button clicks + editor bin button clicks + native console buttons
		settingsPanel.addEventListener('click', (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (target.classList.contains('gg-preset-btn')) {
				const fmt = target.getAttribute('data-format');
				if (fmt) {
					setActiveFormat(fmt);
					renderSettingsUI();
				}
			}
			if (target.classList.contains('gg-editor-bin-btn')) {
				const editor = target.getAttribute('data-editor');
				if (editor !== null) {
					editorBin = editor;
					localStorage.setItem(EDITOR_BIN_KEY, editorBin);
					renderSettingsUI();
				}
			}
			// Native Console: sync localStorage.debug to current gg-filter
			if (target.classList.contains('gg-sync-debug-btn')) {
				const currentFilter = localStorage.getItem(FILTER_KEY) || 'gg:*';
				localStorage.setItem('debug', currentFilter);
				renderSettingsUI();
			}
			// Native Console: clear localStorage.debug
			if (target.classList.contains('gg-clear-debug-btn')) {
				localStorage.removeItem('debug');
				renderSettingsUI();
			}
		});
	}

	function wireUpButtons() {
		if (!$el) return;

		$el.find('.gg-clear-btn').on('click', () => {
			buffer.clear();
			allNamespacesSet.clear();
			renderLogs();
		});

		$el.find('.gg-copy-btn').on('click', async () => {
			const allEntries = buffer.getEntries();
			// Apply same filtering as renderLogs() - only copy visible entries
			const entries = allEntries.filter((entry: CapturedEntry) =>
				enabledNamespaces.has(entry.namespace)
			);

			const text = entries
				.map((e: CapturedEntry) => formatEntryForClipboard(e, showExpressions))
				.join('\n');

			try {
				await navigator.clipboard.writeText(text);
			} catch {
				// Fallback: select and copy
				const textarea = document.createElement('textarea');
				textarea.value = text;
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				document.body.removeChild(textarea);
			}
		});

		$el.find('.gg-expressions-btn').on('click', () => {
			showExpressions = !showExpressions;
			localStorage.setItem(SHOW_EXPRESSIONS_KEY, String(showExpressions));
			// Update button styling inline (toolbar is not re-rendered by renderLogs)
			const btn = $el!.find('.gg-expressions-btn').get(0);
			if (btn) btn.style.background = showExpressions ? '#e8f5e9' : 'transparent';
			renderLogs();
		});
	}

	/** Substitute format variables ($ROOT, $FILE, $LINE, $COL) in a format string */
	function formatString(
		format: string,
		file: string,
		line: string | null,
		col: string | null
	): string {
		return format
			.replace(/\$ROOT/g, projectRoot)
			.replace(/\$FILE/g, file)
			.replace(/\$LINE/g, line || '1')
			.replace(/\$COL/g, col || '1');
	}

	/**
	 * Handle namespace click: open in editor via Vite middleware, copy to clipboard, or open URL.
	 * Behavior is controlled by the nsClickAction setting.
	 */
	function handleNamespaceClick(target: HTMLElement) {
		if (!$el) return;
		const file = target.getAttribute('data-file');
		if (!file) return;

		const line = target.getAttribute('data-line');
		const col = target.getAttribute('data-col');

		if (nsClickAction === 'open' && DEV) {
			// Open in editor via Vite dev server middleware
			let url = `/__open-in-editor?file=${encodeURIComponent(file)}`;
			if (line) url += `&line=${line}`;
			if (line && col) url += `&col=${col}`;
			if (editorBin) url += `&editor=${encodeURIComponent(editorBin)}`;

			const iframe = $el.find('.gg-editor-iframe').get(0) as HTMLIFrameElement | undefined;
			if (iframe) {
				iframe.src = url;
			}
		} else if (nsClickAction === 'open-url') {
			// Open formatted URI in browser (editor handles the URI scheme)
			const formatted = formatString(activeFormat(), file, line, col);
			window.open(formatted, '_blank');
		} else {
			// Copy formatted file path to clipboard
			const formatted = formatString(activeFormat(), file, line, col);

			navigator.clipboard.writeText(formatted).then(() => {
				// Brief "Copied!" feedback on the namespace cell
				const original = target.textContent;
				target.textContent = '\u{1F4CB} Copied!';
				setTimeout(() => {
					target.textContent = original;
				}, 1200);
			});
		}
	}

	/** Show toast bar after hiding a namespace via the x button */
	function showHideToast(namespace: string, previousPattern: string) {
		if (!$el) return;

		lastHiddenPattern = previousPattern;

		const toast = $el.find('.gg-toast').get(0) as HTMLElement;
		if (!toast) return;

		// Split namespace into segments with delimiters (same logic as log row rendering)
		const parts = namespace.split(/([:/@ \-_])/);
		const segments: string[] = [];
		const delimiters: string[] = [];
		for (let i = 0; i < parts.length; i++) {
			if (i % 2 === 0) {
				if (parts[i]) segments.push(parts[i]);
			} else {
				delimiters.push(parts[i]);
			}
		}

		// Build clickable segment HTML
		let nsHTML = '';
		for (let i = 0; i < segments.length; i++) {
			const segment = escapeHtml(segments[i]);

			// Build filter pattern for this segment level
			let segFilter = '';
			for (let j = 0; j <= i; j++) {
				segFilter += segments[j];
				if (j < i) {
					segFilter += delimiters[j];
				} else if (j < segments.length - 1) {
					segFilter += delimiters[j] + '*';
				}
			}

			nsHTML += `<span class="gg-toast-segment" data-filter="${escapeHtml(segFilter)}">${segment}</span>`;
			if (i < segments.length - 1) {
				nsHTML += `<span class="gg-toast-delim">${escapeHtml(delimiters[i])}</span>`;
			}
		}

		// Auto-expand explanation on first use
		const showExplanation = !hasSeenToastExplanation;

		toast.innerHTML =
			`<button class="gg-toast-btn gg-toast-dismiss" title="Dismiss">\u00d7</button>` +
			`<span class="gg-toast-label">Hidden:</span>` +
			`<span class="gg-toast-ns">${nsHTML}</span>` +
			`<span class="gg-toast-actions">` +
			`<button class="gg-toast-btn gg-toast-undo">Undo</button>` +
			`<button class="gg-toast-btn gg-toast-help" title="Toggle help">?</button>` +
			`</span>` +
			`<div class="gg-toast-explanation${showExplanation ? ' visible' : ''}">` +
			`Click a segment above to hide all matching namespaces (e.g. click "api" to hide gg:api:*). ` +
			`Tip: you can also right-click any segment in the log to hide it directly.` +
			`</div>`;

		toast.classList.add('visible');

		if (showExplanation) {
			hasSeenToastExplanation = true;
		}
	}

	/** Dismiss the toast bar */
	function dismissToast() {
		if (!$el) return;
		const toast = $el.find('.gg-toast').get(0) as HTMLElement;
		if (toast) {
			toast.classList.remove('visible');
		}
		lastHiddenPattern = null;
	}

	/** Undo the last namespace hide */
	function undoHide() {
		if (!$el || lastHiddenPattern === null) return;

		// Restore the previous filter pattern
		filterPattern = lastHiddenPattern;
		localStorage.setItem(FILTER_KEY, filterPattern);

		// Sync enabledNamespaces from the restored pattern
		enabledNamespaces.clear();
		const effectivePattern = filterPattern || 'gg:*';
		getAllCapturedNamespaces().forEach((ns) => {
			if (namespaceMatchesPattern(ns, effectivePattern)) {
				enabledNamespaces.add(ns);
			}
		});

		dismissToast();
		renderFilterUI();
		renderLogs();
	}

	/** Wire up toast event handlers (called once after init) */
	function wireUpToast() {
		if (!$el) return;

		const toast = $el.find('.gg-toast').get(0) as HTMLElement;
		if (!toast) return;

		toast.addEventListener('click', (e: MouseEvent) => {
			const target = e.target as HTMLElement;

			// Undo button
			if (target.classList?.contains('gg-toast-undo')) {
				undoHide();
				return;
			}

			// Dismiss button
			if (target.classList?.contains('gg-toast-dismiss')) {
				dismissToast();
				return;
			}

			// Help toggle
			if (target.classList?.contains('gg-toast-help')) {
				const explanation = toast.querySelector('.gg-toast-explanation') as HTMLElement;
				if (explanation) {
					explanation.classList.toggle('visible');
				}
				return;
			}

			// Segment click: add exclusion for that pattern
			if (target.classList?.contains('gg-toast-segment')) {
				const filter = target.getAttribute('data-filter');
				if (!filter) return;

				// Add exclusion pattern (same logic as right-click segment)
				const currentPattern = filterPattern || 'gg:*';
				const exclusion = `-${filter}`;
				const parts = currentPattern.split(',').map((p) => p.trim());

				if (parts.includes(exclusion)) {
					// Already excluded, toggle off
					filterPattern = parts.filter((p) => p !== exclusion).join(',') || 'gg:*';
				} else {
					const hasInclusion = parts.some((p) => !p.startsWith('-'));
					if (hasInclusion) {
						filterPattern = `${currentPattern},${exclusion}`;
					} else {
						filterPattern = `gg:*,${exclusion}`;
					}
				}

				filterPattern = simplifyPattern(filterPattern);

				// Sync enabledNamespaces
				enabledNamespaces.clear();
				const effectivePattern = filterPattern || 'gg:*';
				getAllCapturedNamespaces().forEach((ns) => {
					if (namespaceMatchesPattern(ns, effectivePattern)) {
						enabledNamespaces.add(ns);
					}
				});

				localStorage.setItem(FILTER_KEY, filterPattern);
				dismissToast();
				renderFilterUI();
				renderLogs();
				return;
			}
		});
	}

	function wireUpExpanders() {
		if (!$el || expanderAttached) return;

		// Use native event delegation on the actual DOM element.
		// Licia's .on() doesn't delegate to children replaced by .html().
		const containerEl = $el.find('.gg-log-container').get(0) as HTMLElement | undefined;
		if (!containerEl) return;

		containerEl.addEventListener('click', (e: MouseEvent) => {
			const target = e.target as HTMLElement;

			// Handle reset filter button (shown when all logs filtered out)
			if (target?.classList?.contains('gg-reset-filter-btn')) {
				filterPattern = 'gg:*';
				enabledNamespaces.clear();
				getAllCapturedNamespaces().forEach((ns) => enabledNamespaces.add(ns));
				localStorage.setItem(FILTER_KEY, filterPattern);
				renderFilterUI();
				renderLogs();
				return;
			}

			// Handle expand/collapse
			if (target?.classList?.contains('gg-expand')) {
				const index = target.getAttribute('data-index');
				if (!index) return;

				const details = containerEl.querySelector(
					`.gg-details[data-index="${index}"]`
				) as HTMLElement | null;

				if (details) {
					const nowVisible = details.style.display === 'none';
					details.style.display = nowVisible ? 'block' : 'none';
					// Track state so it survives virtual scroll re-renders
					if (nowVisible) {
						expandedDetails.add(index);
					} else {
						expandedDetails.delete(index);
					}
					// Re-measure the entry so virtualizer adjusts total height
					const entryEl = details.closest('.gg-log-entry') as HTMLElement | null;
					if (entryEl && virtualizer) {
						virtualizer.measureElement(entryEl);
					}
				}
				return;
			}

			// Handle stack trace toggle
			if (target?.classList?.contains('gg-stack-toggle')) {
				const stackId = target.getAttribute('data-stack-id');
				if (!stackId) return;

				const stackEl = containerEl.querySelector(
					`.gg-stack-content[data-stack-id="${stackId}"]`
				) as HTMLElement | null;

				if (stackEl) {
					const isExpanded = stackEl.classList.contains('expanded');
					stackEl.classList.toggle('expanded');
					target.textContent = isExpanded ? '▶ stack' : '▼ stack';
					// Track state so it survives virtual scroll re-renders
					if (isExpanded) {
						expandedStacks.delete(stackId);
					} else {
						expandedStacks.add(stackId);
					}
					// Re-measure the entry so virtualizer adjusts total height
					const entryEl = stackEl.closest('.gg-log-entry') as HTMLElement | null;
					if (entryEl && virtualizer) {
						virtualizer.measureElement(entryEl);
					}
				}
				return;
			}

			// Handle clicking namespace segments - always filter
			if (target?.classList?.contains('gg-ns-segment')) {
				const filter = target.getAttribute('data-filter');
				if (!filter) return;

				// Toggle behavior: if already at this filter, restore all
				if (filterPattern === filter) {
					filterPattern = 'gg:*';
					enabledNamespaces.clear();
					getAllCapturedNamespaces().forEach((ns) => enabledNamespaces.add(ns));
				} else {
					filterPattern = filter;
					enabledNamespaces.clear();
					getAllCapturedNamespaces()
						.filter((ns) => namespaceMatchesPattern(ns, filter))
						.forEach((ns) => enabledNamespaces.add(ns));
				}

				localStorage.setItem(FILTER_KEY, filterPattern);
				renderFilterUI();
				renderLogs();
				return;
			}

			// Handle clicking time diff to open in editor
			if (target?.classList?.contains('gg-log-diff') && target.hasAttribute('data-file')) {
				handleNamespaceClick(target);
				return;
			}

			// Handle clicking hide button for namespace
			if (target?.classList?.contains('gg-ns-hide')) {
				const namespace = target.getAttribute('data-namespace');
				if (!namespace) return;

				// Save current pattern for undo before hiding
				const previousPattern = filterPattern;

				toggleNamespace(namespace, false);
				localStorage.setItem(FILTER_KEY, filterPattern);
				renderFilterUI();
				renderLogs();

				// Show toast with undo option
				showHideToast(namespace, previousPattern);
				return;
			}

			// Clicking background (container or grid, not a log element) restores all
			if (
				filterExpanded &&
				filterPattern !== 'gg:*' &&
				(target === containerEl || target?.classList?.contains('gg-log-grid'))
			) {
				filterPattern = 'gg:*';
				enabledNamespaces.clear();
				getAllCapturedNamespaces().forEach((ns) => enabledNamespaces.add(ns));
				localStorage.setItem(FILTER_KEY, filterPattern);
				renderFilterUI();
				renderLogs();
			}
		});

		// Helper: show confirmation tooltip near target element
		function showConfirmationTooltip(containerEl: HTMLElement, target: HTMLElement, text: string) {
			const tip = containerEl.querySelector('.gg-hover-tooltip') as HTMLElement | null;
			if (!tip) return;

			tip.textContent = text;
			tip.style.display = 'block';

			const targetRect = target.getBoundingClientRect();
			let left = targetRect.left;
			let top = targetRect.bottom + 4;

			const tipRect = tip.getBoundingClientRect();
			if (left + tipRect.width > window.innerWidth) {
				left = window.innerWidth - tipRect.width - 8;
			}
			if (left < 4) left = 4;
			if (top + tipRect.height > window.innerHeight) {
				top = targetRect.top - tipRect.height - 4;
			}

			tip.style.left = `${left}px`;
			tip.style.top = `${top}px`;

			setTimeout(() => {
				tip.style.display = 'none';
			}, 1500);
		}

		// Right-click context actions
		containerEl.addEventListener('contextmenu', (e: MouseEvent) => {
			const target = e.target as HTMLElement;

			// Right-click namespace segment: hide that pattern
			if (target?.classList?.contains('gg-ns-segment')) {
				const filter = target.getAttribute('data-filter');
				if (!filter) return;

				e.preventDefault();

				// Add exclusion pattern: keep current base, add -<pattern>
				const currentPattern = filterPattern || 'gg:*';
				const exclusion = `-${filter}`;

				// Check if already excluded (toggle off)
				const parts = currentPattern.split(',').map((p) => p.trim());
				if (parts.includes(exclusion)) {
					// Remove the exclusion to un-hide
					filterPattern = parts.filter((p) => p !== exclusion).join(',') || 'gg:*';
				} else {
					// Ensure we have a base inclusion pattern
					const hasInclusion = parts.some((p) => !p.startsWith('-'));
					if (hasInclusion) {
						filterPattern = `${currentPattern},${exclusion}`;
					} else {
						filterPattern = `gg:*,${exclusion}`;
					}
				}

				filterPattern = simplifyPattern(filterPattern);

				// Sync enabledNamespaces from the new pattern
				enabledNamespaces.clear();
				const effectivePattern = filterPattern || 'gg:*';
				getAllCapturedNamespaces().forEach((ns) => {
					if (namespaceMatchesPattern(ns, effectivePattern)) {
						enabledNamespaces.add(ns);
					}
				});

				localStorage.setItem(FILTER_KEY, filterPattern);
				renderFilterUI();
				renderLogs();
				return;
			}

			// Right-click time diff: copy file location to clipboard
			if (target?.classList?.contains('gg-log-diff') && target.hasAttribute('data-file')) {
				e.preventDefault();

				const file = target.getAttribute('data-file') || '';
				const line = target.getAttribute('data-line');
				const col = target.getAttribute('data-col');
				const formatted = formatString(activeFormat(), file, line, col);

				navigator.clipboard.writeText(formatted).then(() => {
					showConfirmationTooltip(containerEl, target, `Copied: ${formatted}`);
				});
				return;
			}

			// Right-click message area: copy that single message
			const contentEl = target?.closest?.('.gg-log-content') as HTMLElement | null;
			if (contentEl) {
				const entryEl = contentEl.closest('.gg-log-entry') as HTMLElement | null;
				const entryIdx = entryEl?.getAttribute('data-entry');
				if (entryIdx === null || entryIdx === undefined) return;

				const entry = buffer.get(Number(entryIdx));
				if (!entry) return;

				e.preventDefault();

				const text = formatEntryForClipboard(entry, showExpressions);

				navigator.clipboard.writeText(text).then(() => {
					showConfirmationTooltip(containerEl, contentEl, 'Copied message');
				});
				return;
			}
		});

		// Hover tooltip for expandable objects/arrays.
		// The tooltip div is re-created after each renderLogs() call
		// since logContainer.html() destroys children. Event listeners query it dynamically.

		containerEl.addEventListener('mouseover', (e: MouseEvent) => {
			const target = (e.target as HTMLElement)?.closest?.('.gg-expand') as HTMLElement | null;
			if (!target) return;

			const entryIdx = target.getAttribute('data-entry');
			const argIdx = target.getAttribute('data-arg');
			if (entryIdx === null || argIdx === null) return;

			const entry = buffer.get(Number(entryIdx));
			if (!entry) return;
			const arg = entry.args[Number(argIdx)];
			if (arg === undefined) return;

			const tip = containerEl!.querySelector('.gg-hover-tooltip') as HTMLElement | null;
			if (!tip) return;

			const srcExpr = target.getAttribute('data-src');

			// Build tooltip content using DOM API (safe, no HTML injection)
			tip.textContent = '';
			if (srcExpr) {
				const srcDiv = document.createElement('div');
				srcDiv.className = 'gg-hover-tooltip-src';
				srcDiv.textContent = srcExpr;
				tip.appendChild(srcDiv);
			}
			const pre = document.createElement('pre');
			pre.style.margin = '0';
			pre.textContent = JSON.stringify(arg, null, 2);
			tip.appendChild(pre);

			tip.style.display = 'block';

			// Position below the hovered element using viewport coords (fixed positioning)
			const targetRect = target.getBoundingClientRect();
			let left = targetRect.left;
			let top = targetRect.bottom + 4;

			// Keep tooltip within viewport
			const tipRect = tip.getBoundingClientRect();
			if (left + tipRect.width > window.innerWidth) {
				left = window.innerWidth - tipRect.width - 8;
			}
			if (left < 4) left = 4;
			// If tooltip would go below viewport, show above instead
			if (top + tipRect.height > window.innerHeight) {
				top = targetRect.top - tipRect.height - 4;
			}

			tip.style.left = `${left}px`;
			tip.style.top = `${top}px`;
		});

		containerEl.addEventListener('mouseout', (e: MouseEvent) => {
			const target = (e.target as HTMLElement)?.closest?.('.gg-expand') as HTMLElement | null;
			if (!target) return;

			// Only hide if we're not moving to another child of the same .gg-expand
			const related = e.relatedTarget as HTMLElement | null;
			if (related?.closest?.('.gg-expand') === target) return;

			const tip = containerEl!.querySelector('.gg-hover-tooltip') as HTMLElement | null;
			if (tip) tip.style.display = 'none';
		});

		// Tooltip for time diff (open-in-editor action)
		containerEl.addEventListener('mouseover', (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (!target?.classList?.contains('gg-log-diff')) return;
			if (!target.hasAttribute('data-file')) return;

			const file = target.getAttribute('data-file') || '';
			const line = target.getAttribute('data-line') || '1';
			const col = target.getAttribute('data-col') || '1';

			const tip = containerEl!.querySelector('.gg-hover-tooltip') as HTMLElement | null;
			if (!tip) return;

			// Build tooltip content
			let actionText: string;
			if (nsClickAction === 'open' && DEV) {
				actionText = `Open in editor: ${file}:${line}:${col}`;
			} else if (nsClickAction === 'open-url') {
				actionText = `Open URL: ${formatString(activeFormat(), file, line, col)}`;
			} else {
				actionText = `Copy: ${formatString(activeFormat(), file, line, col)}`;
			}

			tip.textContent = actionText;
			tip.style.display = 'block';

			// Position below the target
			const targetRect = target.getBoundingClientRect();
			let left = targetRect.left;
			let top = targetRect.bottom + 4;

			// Keep tooltip within viewport
			const tipRect = tip.getBoundingClientRect();
			if (left + tipRect.width > window.innerWidth) {
				left = window.innerWidth - tipRect.width - 8;
			}
			if (left < 4) left = 4;
			if (top + tipRect.height > window.innerHeight) {
				top = targetRect.top - tipRect.height - 4;
			}

			tip.style.left = `${left}px`;
			tip.style.top = `${top}px`;
		});

		containerEl.addEventListener('mouseout', (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (!target?.classList?.contains('gg-log-diff')) return;

			const tip = containerEl!.querySelector('.gg-hover-tooltip') as HTMLElement | null;
			if (tip) tip.style.display = 'none';
		});

		expanderAttached = true;
	}

	function wireUpResize() {
		if (!$el || resizeAttached) return;

		const containerEl = $el.find('.gg-log-container').get(0) as HTMLElement | undefined;
		if (!containerEl) return;

		let dragging = false;
		let startX = 0;
		let startWidth = 0;

		function onPointerDown(e: PointerEvent) {
			const target = e.target as HTMLElement;
			if (!target?.classList?.contains('gg-log-handle')) return;

			e.preventDefault();
			dragging = true;
			target.classList.add('gg-dragging');
			target.setPointerCapture(e.pointerId);

			startX = e.clientX;

			// Measure current namespace column width from a sibling .gg-log-ns
			const grid = containerEl!.querySelector('.gg-log-grid') as HTMLElement | null;
			const nsCell = grid?.querySelector('.gg-log-ns') as HTMLElement | null;
			startWidth = nsCell ? nsCell.getBoundingClientRect().width : 200;
		}

		function onPointerMove(e: PointerEvent) {
			if (!dragging) return;
			const delta = e.clientX - startX;
			const newWidth = Math.max(40, startWidth + delta);
			nsColWidth = newWidth;

			// Update grid template on the live element (no full re-render)
			const grid = containerEl!.querySelector('.gg-log-grid') as HTMLElement | null;
			if (grid) {
				grid.style.gridTemplateColumns = gridColumns();
			}
		}

		function onPointerUp(e: PointerEvent) {
			if (!dragging) return;
			dragging = false;
			const target = e.target as HTMLElement;
			target?.classList?.remove('gg-dragging');
		}

		containerEl.addEventListener('pointerdown', onPointerDown);
		containerEl.addEventListener('pointermove', onPointerMove);
		containerEl.addEventListener('pointerup', onPointerUp);

		resizeAttached = true;
	}

	/** Build the HTML string for a single log entry.
	 * @param index Buffer index (used for data-entry, expand IDs, tooltip lookup)
	 * @param virtualIndex Position in filteredIndices (used by virtualizer for measurement)
	 */
	function renderEntryHTML(entry: CapturedEntry, index: number, virtualIndex?: number): string {
		const color = entry.color || '#0066cc';
		const diff = `+${humanize(entry.diff)}`;

		// Split namespace into clickable segments on multiple delimiters: : @ / - _
		const parts = entry.namespace.split(/([:/@ \-_])/);
		const nsSegments: string[] = [];
		const delimiters: string[] = [];

		for (let i = 0; i < parts.length; i++) {
			if (i % 2 === 0) {
				// Even indices are segments
				if (parts[i]) nsSegments.push(parts[i]);
			} else {
				// Odd indices are delimiters
				delimiters.push(parts[i]);
			}
		}

		let nsHTML = '';
		for (let i = 0; i < nsSegments.length; i++) {
			const segment = escapeHtml(nsSegments[i]);

			// Build filter pattern: reconstruct namespace up to this point
			let filterPattern = '';
			for (let j = 0; j <= i; j++) {
				filterPattern += nsSegments[j];
				if (j < i) {
					filterPattern += delimiters[j];
				} else if (j < nsSegments.length - 1) {
					filterPattern += delimiters[j] + '*';
				}
			}

			nsHTML += `<span class="gg-ns-segment" data-filter="${escapeHtml(filterPattern)}">${segment}</span>`;
			if (i < nsSegments.length - 1) {
				nsHTML += escapeHtml(delimiters[i]);
			}
		}

		// Format each arg individually - objects are expandable
		let argsHTML = '';
		let detailsHTML = '';
		// Source expression for this entry (used in hover tooltips and expanded details)
		const srcExpr = entry.src?.trim() && !/^['"`]/.test(entry.src) ? escapeHtml(entry.src) : '';

		// HTML table rendering for gg.table() entries
		if (entry.tableData && entry.tableData.keys.length > 0) {
			const { keys, rows: tableRows } = entry.tableData;
			const headerCells = keys
				.map(
					(k) =>
						`<th style="padding: 2px 8px; border: 1px solid #ccc; background: #f0f0f0; font-size: 11px; white-space: nowrap;">${escapeHtml(k)}</th>`
				)
				.join('');
			const bodyRowsHtml = tableRows
				.map((row) => {
					const cells = keys
						.map((k) => {
							const val = row[k];
							const display = val === undefined ? '' : escapeHtml(String(val));
							return `<td style="padding: 2px 8px; border: 1px solid #ddd; font-size: 11px; white-space: nowrap;">${display}</td>`;
						})
						.join('');
					return `<tr>${cells}</tr>`;
				})
				.join('');
			argsHTML = `<div style="overflow-x: auto;"><table style="border-collapse: collapse; margin: 2px 0; font-family: monospace;"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRowsHtml}</tbody></table></div>`;
		} else if (entry.args.length > 0) {
			argsHTML = entry.args
				.map((arg, argIdx) => {
					if (typeof arg === 'object' && arg !== null) {
						// Show expandable object
						const preview = Array.isArray(arg) ? `Array(${arg.length})` : 'Object';
						const jsonStr = escapeHtml(JSON.stringify(arg, null, 2));
						const uniqueId = `${index}-${argIdx}`;
						// Expression header inside expanded details
						const srcHeader = srcExpr ? `<div class="gg-details-src">${srcExpr}</div>` : '';
						// Store details separately to render after the row.
						// Restore expanded state from expandedDetails set so it
						// survives virtual scroll re-renders.
						const detailsVisible = expandedDetails.has(uniqueId);
						detailsHTML += `<div class="gg-details" data-index="${uniqueId}" style="display: ${detailsVisible ? 'block' : 'none'}; margin: 4px 0 8px 0; padding: 8px; background: #f8f8f8; border-left: 3px solid ${color}; font-size: 11px; overflow-x: auto;">${srcHeader}<pre style="margin: 0;">${jsonStr}</pre></div>`;
						// data-entry/data-arg for hover tooltip lookup, data-src for expression context
						const srcAttr = srcExpr ? ` data-src="${srcExpr}"` : '';
						const srcIcon = srcExpr ? `<span class="gg-src-icon">\uD83D\uDD0D</span>` : '';
						// Show expression on its own line above the value when toggle is enabled
						const exprAbove =
							showExpressions && srcExpr
								? `<div class="gg-inline-expr">\u2039${srcExpr}\u203A</div>`
								: '';
						return `${exprAbove}<span style="color: #888; cursor: pointer; text-decoration: underline;" class="gg-expand" data-index="${uniqueId}" data-entry="${index}" data-arg="${argIdx}"${srcAttr}>${srcIcon}${preview}</span>`;
					} else {
						// Parse ANSI codes first, then convert URLs to clickable links
						const argStr = String(arg);
						const parsedAnsi = parseAnsiToHtml(argStr);
						return `<span>${parsedAnsi}</span>`;
					}
				})
				.join(' ');
		}

		// Open-in-editor data attributes (file, line, col)
		const fileAttr = entry.file ? ` data-file="${escapeHtml(entry.file)}"` : '';
		const lineAttr = entry.line ? ` data-line="${entry.line}"` : '';
		const colAttr = entry.col ? ` data-col="${entry.col}"` : '';

		// Level class for info/warn/error styling
		const levelClass =
			entry.level === 'info'
				? ' gg-level-info'
				: entry.level === 'warn'
					? ' gg-level-warn'
					: entry.level === 'error'
						? ' gg-level-error'
						: '';

		// Stack trace toggle (for error/trace entries with captured stacks).
		// Restore expanded state from expandedStacks set so it survives
		// virtual scroll re-renders.
		let stackHTML = '';
		if (entry.stack) {
			const stackId = `stack-${index}`;
			const stackExpanded = expandedStacks.has(stackId);
			stackHTML =
				`<span class="gg-stack-toggle" data-stack-id="${stackId}">${stackExpanded ? '▼' : '▶'} stack</span>` +
				`<div class="gg-stack-content${stackExpanded ? ' expanded' : ''}" data-stack-id="${stackId}">${escapeHtml(entry.stack)}</div>`;
		}

		// Expression tooltip: skip table entries (tableData) -- expression is just gg.table(...) which isn't useful
		const hasSrcExpr =
			!entry.level && !entry.tableData && entry.src?.trim() && !/^['"`]/.test(entry.src);
		// For primitives-only entries, show expression on its own line above the value when showExpressions is enabled
		const exprAboveForPrimitives =
			showExpressions && hasSrcExpr && !argsHTML.includes('gg-expand')
				? `<div class="gg-inline-expr">\u2039${escapeHtml(entry.src!)}\u203A</div>`
				: '';

		const vindexAttr = virtualIndex !== undefined ? ` data-vindex="${virtualIndex}"` : '';
		return (
			`<div class="gg-log-entry${levelClass}" data-entry="${index}"${vindexAttr}>` +
			`<div class="gg-log-header">` +
			`<div class="gg-log-diff" style="color: ${color};"${fileAttr}${lineAttr}${colAttr}>${diff}</div>` +
			`<div class="gg-log-ns" style="color: ${color};" data-namespace="${escapeHtml(entry.namespace)}"><span class="gg-ns-text">${nsHTML}</span><button class="gg-ns-hide" data-namespace="${escapeHtml(entry.namespace)}" title="Hide this namespace">\u00d7</button></div>` +
			`<div class="gg-log-handle"></div>` +
			`</div>` +
			`<div class="gg-log-content"${hasSrcExpr ? ` data-src="${escapeHtml(entry.src!)}"` : ''}>${exprAboveForPrimitives}${argsHTML}${stackHTML}</div>` +
			detailsHTML +
			`</div>`
		);
	}

	/** Update the copy-button count text */
	function updateTruncationBanner() {
		if (!$el) return;
		const banner = $el.find('.gg-truncation-banner').get(0) as HTMLElement | undefined;
		if (!banner) return;
		const evicted = buffer.evicted;
		if (evicted > 0) {
			const total = buffer.totalPushed;
			const retained = buffer.size;
			banner.innerHTML = `⚠ Showing ${retained.toLocaleString()} of ${total.toLocaleString()} messages &mdash; ${evicted.toLocaleString()} truncated. Increase <code style="font-family:monospace;background:rgba(255,255,255,0.15);padding:0 3px;border-radius:3px;">maxEntries</code> to retain more.`;
			banner.style.display = 'flex';
		} else {
			banner.style.display = 'none';
		}
	}

	function updateCopyCount() {
		if (!$el) return;
		const copyCountSpan = $el.find('.gg-copy-count');
		if (!copyCountSpan.length) return;
		const allCount = buffer.size;
		const visibleCount = filteredIndices.length;
		const countText =
			visibleCount === allCount
				? `Copy ${visibleCount} ${visibleCount === 1 ? 'entry' : 'entries'}`
				: `Copy ${visibleCount} / ${allCount} ${visibleCount === 1 ? 'entry' : 'entries'}`;
		copyCountSpan.html(countText);
	}

	// ─── Virtual scroll helpers ───────────────────────────────────────────

	/** Rebuild the filtered index list from the buffer. */
	function rebuildFilteredIndices() {
		filteredIndices = [];
		for (let i = 0; i < buffer.size; i++) {
			const entry = buffer.get(i)!;
			if (enabledNamespaces.has(entry.namespace)) {
				filteredIndices.push(i);
			}
		}
	}

	/** Track whether user is near bottom (for auto-scroll decisions). */
	let userNearBottom = true;

	/**
	 * Render the visible virtual items into the DOM grid.
	 * Called by the virtualizer's onChange and after new entries arrive.
	 */
	let isRendering = false;
	function renderVirtualItems() {
		// Guard against re-entrant calls (measureElement → onChange → renderVirtualItems)
		if (isRendering) return;
		if (!$el || !virtualizer) return;
		const containerDom = $el.find('.gg-log-container').get(0) as HTMLElement | undefined;
		if (!containerDom) return;
		const spacer = containerDom.querySelector('.gg-virtual-spacer') as HTMLElement | null;
		const grid = containerDom.querySelector('.gg-log-grid') as HTMLElement | null;
		if (!spacer || !grid) return;

		const items = virtualizer.getVirtualItems();
		if (items.length === 0) {
			grid.innerHTML = '';
			return;
		}

		// Set the spacer's height so the scrollbar reflects the full virtual list
		spacer.style.height = `${virtualizer.getTotalSize()}px`;

		// Position the grid at the start offset of the first visible item
		const startOffset = items[0].start;
		grid.style.transform = `translateY(${startOffset}px)`;

		// Build HTML only for visible items
		const html = items
			.map((item) => {
				const bufferIdx = filteredIndices[item.index];
				const entry = buffer.get(bufferIdx);
				if (!entry) return '';
				return renderEntryHTML(entry, bufferIdx, item.index);
			})
			.join('');

		grid.innerHTML = html;

		// After inserting HTML, measure each rendered entry so the virtualizer
		// learns actual heights (drives dynamic sizing).
		isRendering = true;
		try {
			const entryEls = grid.querySelectorAll('.gg-log-entry');
			entryEls.forEach((el) => {
				virtualizer!.measureElement(el as HTMLElement);
			});
		} finally {
			isRendering = false;
		}
	}

	/**
	 * Create or reconfigure the virtualizer for the current filteredIndices.
	 * Call after filter changes or full rebuilds.
	 */
	function setupVirtualizer(scrollToBottom: boolean) {
		if (!$el) return;
		const containerDom = $el.find('.gg-log-container').get(0) as HTMLElement | undefined;
		if (!containerDom) return;

		// Tear down previous virtualizer
		if (virtualizer) {
			virtualizer.setOptions({
				...virtualizer.options,
				count: 0,
				enabled: false
			});
			virtualizer = null;
		}

		const count = filteredIndices.length;
		if (count === 0) return;

		virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
			count,
			getScrollElement: () => containerDom,
			estimateSize: () => 24, // estimated row height in px
			overscan: 10,
			observeElementRect,
			observeElementOffset,
			scrollToFn: elementScroll,
			measureElement: (el, entry, instance) => measureElement(el, entry, instance),
			// Use buffer index as the stable key for each virtual row
			getItemKey: (index) => filteredIndices[index],
			// The data-index attribute TanStack uses to find elements for measurement
			indexAttribute: 'data-vindex',
			onChange: () => {
				renderVirtualItems();
			}
		});

		// Mount the virtualizer (attaches scroll/resize observers)
		const cleanup = virtualizer._didMount();
		// Store cleanup for when we tear down (TODO: call on destroy)
		(containerDom as any).__ggVirtualCleanup = cleanup;

		if (scrollToBottom) {
			virtualizer.scrollToIndex(count - 1, { align: 'end' });
		}

		// Initial render
		virtualizer._willUpdate();
		renderVirtualItems();
	}

	/**
	 * Incremental append: add new entries to the virtual scroll.
	 * Called from the rAF-batched _onLog path.
	 */
	function appendLogs(newEntries: CapturedEntry[]) {
		if (!$el) return;

		const logContainer = $el.find('.gg-log-container');
		if (!logContainer.length) return;
		const containerDom = logContainer.get(0) as HTMLElement | undefined;
		if (!containerDom) return;

		// Check if we need a full render (no grid yet, or empty state showing)
		const grid = containerDom.querySelector('.gg-log-grid');
		if (!grid) {
			renderLogs();
			return;
		}

		// Check if any new entries pass the filter
		const hasVisible = newEntries.some((e) => enabledNamespaces.has(e.namespace));
		if (!hasVisible && buffer.evicted === 0) {
			updateCopyCount();
			return;
		}

		// Rebuild filteredIndices from scratch. This is O(buffer.size) with a
		// Set lookup per entry — ~0.1ms for 2000 entries. Always correct even
		// when the buffer wraps and old logical indices shift.
		rebuildFilteredIndices();

		updateCopyCount();
		updateTruncationBanner();

		// Check if user is near bottom before we update the virtualizer
		const nearBottom =
			containerDom.scrollHeight - containerDom.scrollTop - containerDom.clientHeight < 50;
		userNearBottom = nearBottom;

		// Update virtualizer count and re-render
		if (virtualizer) {
			virtualizer.setOptions({
				...virtualizer.options,
				count: filteredIndices.length,
				getItemKey: (index) => filteredIndices[index]
			});
			virtualizer._willUpdate();

			if (userNearBottom) {
				virtualizer.scrollToIndex(filteredIndices.length - 1, { align: 'end' });
			}

			renderVirtualItems();
		} else {
			// First entries — set up the virtualizer
			setupVirtualizer(true);
		}

		// Re-wire expanders (idempotent — only attaches once)
		wireUpExpanders();
	}

	/** Full render: rebuild the entire log view (used for filter changes, clear, show, etc.) */
	function renderLogs() {
		if (!$el) return;

		const logContainer = $el.find('.gg-log-container');
		if (!logContainer.length) return;

		// Clear expansion state on full rebuild
		expandedDetails.clear();
		expandedStacks.clear();

		// Rebuild filtered indices from scratch
		rebuildFilteredIndices();

		updateCopyCount();
		updateTruncationBanner();

		if (filteredIndices.length === 0) {
			// Tear down virtualizer
			if (virtualizer) {
				const containerDom = logContainer.get(0) as HTMLElement | undefined;
				if (containerDom) {
					const cleanup = (containerDom as any).__ggVirtualCleanup;
					if (cleanup) cleanup();
				}
				virtualizer = null;
			}

			const hasFilteredLogs = buffer.size > 0;
			const message = hasFilteredLogs
				? `All ${buffer.size} logs filtered out.`
				: 'No logs captured yet. Call gg() to see output here.';
			const resetButton = hasFilteredLogs
				? '<button class="gg-reset-filter-btn" style="margin-top: 12px; padding: 10px 20px; cursor: pointer; border: 1px solid #2196F3; background: #2196F3; color: white; border-radius: 6px; font-size: 13px; font-weight: 500; transition: background 0.2s;">Show all logs (gg:*)</button>'
				: '';
			logContainer.html(
				`<div style="padding: 20px; text-align: center; opacity: 0.5;">${message}<div>${resetButton}</div></div>`
			);
			return;
		}

		// Build the virtual scroll DOM structure:
		// - .gg-virtual-spacer: sized to total virtual height (provides scrollbar)
		//   - .gg-log-grid: positioned absolutely, translated to visible offset, holds only visible entries
		const gridClasses = `gg-log-grid${filterExpanded ? ' filter-mode' : ''}${showExpressions ? ' gg-show-expr' : ''}`;
		logContainer.html(
			`<div class="gg-virtual-spacer">` +
				`<div class="${gridClasses}" style="position: absolute; top: 0; left: 0; width: 100%; grid-template-columns: ${gridColumns()};"></div>` +
				`</div>` +
				`<div class="gg-hover-tooltip"></div>`
		);

		// Re-wire event delegation (idempotent)
		wireUpExpanders();

		// Create virtualizer and render
		setupVirtualizer(true);
	}

	/** Format ms like debug's `ms` package: 0ms, 500ms, 5s, 2m, 1h, 3d */
	function humanize(ms: number): string {
		const abs = Math.abs(ms);
		if (abs >= 86400000) return Math.round(ms / 86400000) + 'd ';
		if (abs >= 3600000) return Math.round(ms / 3600000) + 'h ';
		if (abs >= 60000) return Math.round(ms / 60000) + 'm ';
		if (abs >= 1000) return Math.round(ms / 1000) + 's ';
		return Math.round(ms) + 'ms';
	}

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	/**
	 * Strip ANSI escape codes from text
	 * Removes all ANSI escape sequences like \x1b[...m
	 */
	function stripAnsi(text: string): string {
		// Remove all ANSI escape codes
		// eslint-disable-next-line no-control-regex
		return text.replace(/\x1b\[[0-9;]*m/g, '');
	}

	// Standard ANSI 3/4-bit color palette
	const ANSI_COLORS: Record<number, string> = {
		// Normal foreground (30-37)
		30: '#000000',
		31: '#cc0000',
		32: '#00cc00',
		33: '#cccc00',
		34: '#0000cc',
		35: '#cc00cc',
		36: '#00cccc',
		37: '#cccccc',
		// Normal background (40-47)
		40: '#000000',
		41: '#cc0000',
		42: '#00cc00',
		43: '#cccc00',
		44: '#0000cc',
		45: '#cc00cc',
		46: '#00cccc',
		47: '#cccccc',
		// Bright foreground (90-97)
		90: '#555555',
		91: '#ff5555',
		92: '#55ff55',
		93: '#ffff55',
		94: '#5555ff',
		95: '#ff55ff',
		96: '#55ffff',
		97: '#ffffff',
		// Bright background (100-107)
		100: '#555555',
		101: '#ff5555',
		102: '#55ff55',
		103: '#ffff55',
		104: '#5555ff',
		105: '#ff55ff',
		106: '#55ffff',
		107: '#ffffff'
	};

	/**
	 * Parse ANSI escape codes and convert to HTML with inline styles
	 * Supports:
	 * - Basic 3/4-bit colors: \x1b[31m (fg red), \x1b[41m (bg red), \x1b[91m (bright fg), etc.
	 * - 24-bit RGB: \x1b[38;2;r;g;bm (foreground), \x1b[48;2;r;g;bm (background)
	 * - Text styles: \x1b[1m (bold), \x1b[2m (dim), \x1b[3m (italic), \x1b[4m (underline)
	 * - Reset: \x1b[0m
	 */
	function parseAnsiToHtml(text: string): string {
		// ANSI escape sequence regex
		// eslint-disable-next-line no-control-regex
		const ansiRegex = /\x1b\[([0-9;]+)m/g;

		let html = '';
		let lastIndex = 0;
		let currentFg: string | null = null;
		let currentBg: string | null = null;
		let currentBold = false;
		let currentDim = false;
		let currentItalic = false;
		let currentUnderline = false;
		let match;

		while ((match = ansiRegex.exec(text)) !== null) {
			// Add text before this code (with current styling)
			const textBefore = text.slice(lastIndex, match.index);
			if (textBefore) {
				html += wrapWithStyle(
					escapeHtml(textBefore),
					currentFg,
					currentBg,
					currentBold,
					currentDim,
					currentItalic,
					currentUnderline
				);
			}

			// Parse the ANSI code
			const code = match[1];
			const parts = code.split(';').map(Number);

			if (parts[0] === 0) {
				// Reset all
				currentFg = null;
				currentBg = null;
				currentBold = false;
				currentDim = false;
				currentItalic = false;
				currentUnderline = false;
			} else if (parts[0] === 1) {
				// Bold
				currentBold = true;
			} else if (parts[0] === 2) {
				// Dim/Faint
				currentDim = true;
			} else if (parts[0] === 3) {
				// Italic
				currentItalic = true;
			} else if (parts[0] === 4) {
				// Underline
				currentUnderline = true;
			} else if (parts[0] === 22) {
				// Normal intensity (not bold, not dim)
				currentBold = false;
				currentDim = false;
			} else if (parts[0] === 23) {
				// Not italic
				currentItalic = false;
			} else if (parts[0] === 24) {
				// Not underlined
				currentUnderline = false;
			} else if (parts[0] === 38 && parts[1] === 2 && parts.length >= 5) {
				// Foreground RGB: 38;2;r;g;b
				currentFg = `rgb(${parts[2]},${parts[3]},${parts[4]})`;
			} else if (parts[0] === 48 && parts[1] === 2 && parts.length >= 5) {
				// Background RGB: 48;2;r;g;b
				currentBg = `rgb(${parts[2]},${parts[3]},${parts[4]})`;
			} else if (parts[0] === 39) {
				// Default foreground
				currentFg = null;
			} else if (parts[0] === 49) {
				// Default background
				currentBg = null;
			} else {
				// Basic 3/4-bit colors
				for (const p of parts) {
					if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
						currentFg = ANSI_COLORS[p] || null;
					} else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
						currentBg = ANSI_COLORS[p] || null;
					}
				}
			}

			lastIndex = ansiRegex.lastIndex;
		}

		// Add remaining text
		const remaining = text.slice(lastIndex);
		if (remaining) {
			html += wrapWithStyle(
				escapeHtml(remaining),
				currentFg,
				currentBg,
				currentBold,
				currentDim,
				currentItalic,
				currentUnderline
			);
		}

		return html || escapeHtml(text);
	}

	/**
	 * Wrap text with inline color and text style CSS
	 */
	function wrapWithStyle(
		text: string,
		fg: string | null,
		bg: string | null,
		bold: boolean,
		dim: boolean,
		italic: boolean,
		underline: boolean
	): string {
		if (!fg && !bg && !bold && !dim && !italic && !underline) return text;

		const styles: string[] = [];
		if (fg) styles.push(`color: ${fg}`);
		if (bg) styles.push(`background-color: ${bg}`);
		if (bold) styles.push('font-weight: bold');
		if (dim) styles.push('opacity: 0.6');
		if (italic) styles.push('font-style: italic');
		if (underline) styles.push('text-decoration: underline');

		return `<span style="${styles.join('; ')}">${text}</span>`;
	}

	return plugin;
}
