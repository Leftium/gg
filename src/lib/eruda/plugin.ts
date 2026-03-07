import type { GgErudaOptions, CapturedEntry, DroppedNamespaceInfo } from './types.js';
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
	gg: {
		_onLog?: ((entry: CapturedEntry) => void) | null;
		addLogListener?: (callback: (entry: CapturedEntry) => void) => void;
		removeLogListener?: (callback: (entry: CapturedEntry) => void) => void;
	}
) {
	const _savedCap =
		typeof localStorage !== 'undefined'
			? parseInt(localStorage.getItem('gg-buffer-cap') ?? '', 10)
			: NaN;
	const buffer = new LogBuffer(
		!isNaN(_savedCap) && _savedCap > 0 ? _savedCap : (options.maxEntries ?? 2000)
	);
	// The licia jQuery-like wrapper Eruda passes to init()
	let $el: LiciaElement | null = null;
	let expanderAttached = false;
	let resizeAttached = false;
	// null = auto (fit content), number = user-dragged px width
	let nsColWidth: number | null = null;
	// Filter UI state
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

	// Toast state
	let lastHiddenPattern: string | null = null; // filterPattern before the hide (for undo)
	let lastDroppedPattern: string | null = null; // keepPattern before the drop (for undo)
	let lastKeptPattern: string | null = null; // keepPattern before the [+] keep (for undo)
	let lastKeptNamespaceInfo: { ns: string; info: DroppedNamespaceInfo } | null = null; // sentinel entry to restore on undo
	let toastMode: 'hide' | 'drop' | 'keep' = 'hide'; // which layer the current toast targets
	let hasSeenToastExplanation = false; // first toast auto-expands help text

	// Sentinel section debounce: pending rAF for re-rendering dropped sentinels
	let sentinelRenderPending = false;
	// Whether the sentinel section is expanded (persists across re-renders)
	let sentinelExpanded = true;

	// Settings UI state
	let settingsExpanded = false;

	// Layer 1: Keep gate pattern ('gg-keep') — controls which loggs enter the ring buffer.
	// Default 'gg:*' (keep all gg namespaces). Users narrow it to reduce buffer pressure.
	let keepPattern = 'gg:*';

	// Native console output toggle ('gg-console')
	// Default: true (gg works without Eruda), but Eruda flips it to false on init
	// unless the user has explicitly set it.
	let ggConsoleEnabled = true;

	// Expression visibility toggle
	let showExpressions = false;

	// Filter pattern persistence keys
	const SHOW_KEY = 'gg-show'; // Layer 2: which kept loggs to display in panel + console
	const KEEP_KEY = 'gg-keep'; // Layer 1: which loggs enter the ring buffer
	const CONSOLE_KEY = 'gg-console'; // Whether shown loggs also go to native console
	const SHOW_EXPRESSIONS_KEY = 'gg-show-expressions';
	const BUFFER_CAP_KEY = 'gg-buffer-cap'; // Ring buffer capacity (maxEntries)

	// Backward-compat alias (old key name — ignored after migration)
	const LEGACY_FILTER_KEY = 'gg-filter';

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

	// Phase 2: loggs dropped by the keep gate, tracked outside the ring buffer.
	// Key: namespace string. Grows with distinct dropped namespaces (expected: tens, not thousands).
	const droppedNamespaces = new Map<string, DroppedNamespaceInfo>();

	// Total loggs ever received (kept + dropped), and distinct namespaces ever seen (including dropped).
	let receivedTotal = 0;
	const receivedNsSet = new Set<string>();

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
		const ns = entry.namespace.trim();
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

			// Load filter state BEFORE registering _onLog hook, because registering
			// triggers replay of earlyLogBuffer and each entry checks filterPattern
			const _legacyFilter = localStorage.getItem(LEGACY_FILTER_KEY);
			filterPattern = localStorage.getItem(SHOW_KEY) || _legacyFilter || 'gg:*';
			keepPattern = localStorage.getItem(KEEP_KEY) || 'gg:*';
			showExpressions = localStorage.getItem(SHOW_EXPRESSIONS_KEY) === 'true';

			// gg-console: Eruda flips to false on init, unless user explicitly set it.
			// This lets gg work zero-config (console output enabled) before Eruda loads,
			// while silencing the noise when the Eruda panel is in use.
			const userSetConsole = localStorage.getItem(CONSOLE_KEY);
			if (userSetConsole === null) {
				// Not explicitly set — Eruda auto-flips to false
				localStorage.setItem(CONSOLE_KEY, 'false');
				ggConsoleEnabled = false;
			} else {
				ggConsoleEnabled = userSetConsole !== 'false';
			}
			// Tell the debug factory to reload its enabled state from gg-show/gg-console.
			// browser.ts load() now reads gg-console + gg-show instead of localStorage.debug.
			// Re-calling enable() with the right pattern updates which namespaces output to console.
			import('../debug/index.js').then(({ default: dbg }) => {
				try {
					// Only call enable() when console output is on — enable('') would
					// call localStorage.removeItem('gg-show'), wiping the persisted Show filter.
					// When console is disabled, load() in browser.ts already returns '' via
					// the gg-console=false check, so no enable() call is needed.
					if (ggConsoleEnabled) {
						dbg.enable(filterPattern || 'gg:*');
					}
				} catch {
					// ignore
				}
			});

			// Register the capture hook on gg (prefer multi-listener API, fall back to legacy)
			if (gg) {
				const onEntry = (entry: CapturedEntry) => {
					// Track total received (before any filtering)
					receivedTotal++;
					receivedNsSet.add(entry.namespace);

					// Layer 1: Keep gate — drop loggs that don't match gg-keep
					const effectiveKeep = keepPattern || 'gg:*';
					if (!namespaceMatchesPattern(entry.namespace, effectiveKeep)) {
						// Logg is dropped — not stored in ring buffer. Track it in droppedNamespaces.
						const typeKey = entry.level ?? 'log';
						const existing = droppedNamespaces.get(entry.namespace);
						if (existing) {
							existing.lastSeen = entry.timestamp;
							existing.total++;
							existing.byType[typeKey] = (existing.byType[typeKey] ?? 0) + 1;
							existing.preview = entry;
						} else {
							droppedNamespaces.set(entry.namespace, {
								namespace: entry.namespace,
								firstSeen: entry.timestamp,
								lastSeen: entry.timestamp,
								total: 1,
								byType: { [typeKey]: 1 },
								preview: entry
							});
						}
						// Schedule debounced sentinel re-render
						scheduleSentinelRender();
						return;
					}

					// Track namespaces incrementally (O(1) instead of scanning buffer)
					const isNewNamespace = !allNamespacesSet.has(entry.namespace);
					allNamespacesSet.add(entry.namespace);
					buffer.push(entry);
					// Layer 2: Show filter — track which namespaces are currently visible
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

				if (gg.addLogListener) {
					gg.addLogListener(onEntry);
					// Store reference for removal on destroy
					(gg as { __ggErudaListener?: typeof onEntry }).__ggErudaListener = onEntry;
				} else {
					// Legacy fallback: single-slot _onLog
					gg._onLog = onEntry;
				}
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
			wireUpKeepUI();
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
				const listener = (gg as { __ggErudaListener?: (entry: CapturedEntry) => void })
					.__ggErudaListener;
				if (gg.removeLogListener && listener) {
					gg.removeLogListener(listener);
					delete (gg as { __ggErudaListener?: (entry: CapturedEntry) => void }).__ggErudaListener;
				} else {
					gg._onLog = null;
				}
			}
			// Clean up virtualizer
			if (virtualizer && $el) {
				const containerDom = $el.find('.gg-log-container').get(0) as HTMLElement | undefined;
				if (containerDom) {
					const cleanup = (containerDom as HTMLElement & { __ggVirtualCleanup?: () => void })
						.__ggVirtualCleanup;
					if (cleanup) cleanup();
				}
				virtualizer = null;
			}
			buffer.clear();
			allNamespacesSet.clear();
			droppedNamespaces.clear();
			filteredIndices = [];
			receivedTotal = 0;
			receivedNsSet.clear();
		},

		/** Returns a read-only view of the dropped-namespace tracking map (Phase 2 data layer). */
		getDroppedNamespaces(): ReadonlyMap<string, DroppedNamespaceInfo> {
			return droppedNamespaces;
		}
	};

	function toggleKeepNamespace(namespace: string, enable: boolean) {
		const currentPattern = keepPattern || 'gg:*';
		const ns = namespace.trim();
		const parts = currentPattern
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean);

		if (enable) {
			// Remove exclusion — namespace is now kept
			const filtered = parts.filter((p) => p !== `-${ns}`);
			keepPattern = filtered.join(',') || 'gg:*';
			// Remove from droppedNamespaces so sentinel disappears
			droppedNamespaces.delete(ns);
		} else {
			// Add exclusion — namespace is dropped
			const exclusion = `-${ns}`;
			if (!parts.includes(exclusion)) parts.push(exclusion);
			keepPattern = parts.join(',');
		}

		keepPattern = simplifyPattern(keepPattern) || 'gg:*';
		localStorage.setItem(KEEP_KEY, keepPattern);
	}

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

		localStorage.setItem(SHOW_KEY, filterPattern);
	}

	function simplifyPattern(pattern: string): string {
		if (!pattern) return '';

		// Remove empty parts and duplicates
		let parts = Array.from(
			new Set(
				pattern
					.split(',')
					.map((p) => p.trim())
					.filter(Boolean)
			)
		);

		const inclusions = parts.filter((p) => !p.startsWith('-'));
		const exclusions = parts.filter((p) => p.startsWith('-'));
		const hasWildcardBase = inclusions.includes('gg:*') || inclusions.includes('*');
		const wildcardBase = inclusions.includes('gg:*') ? 'gg:*' : '*';

		// If there's a wildcard base (gg:* or *), drop all other inclusions (they're subsumed)
		const finalInclusions = hasWildcardBase ? [wildcardBase] : inclusions;

		// Drop exclusions that are subsumed by a broader exclusion.
		// e.g. -routes/demo-helpers.ts:validation is subsumed by -routes/demo-*
		const finalExclusions = exclusions.filter((excl) => {
			const exclNs = excl.slice(1); // strip leading '-'
			// Keep this exclusion only if no other exclusion is broader and covers it
			return !exclusions.some((other) => {
				if (other === excl) return false;
				const otherNs = other.slice(1);
				return matchesGlob(exclNs, otherNs);
			});
		});

		// If there's a wildcard base, also drop inclusions that match no exclusion boundary
		// (they can't add any namespace that * doesn't already include)
		// Final inclusions are already collapsed to ['*'] above, so nothing more to do.

		return [...finalInclusions, ...finalExclusions].join(',');
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
		// 1. '*' with optional exclusions (e.g. '*,-api:verbose:*')
		// 2. Explicit comma-separated list of exact namespaces (no wildcards, no exclusions)

		const parts = pattern.split(',').map((p) => p.trim());

		// Check if it's '*' or 'gg:*' based (with exclusions)
		const hasWildcardBase = parts.some((p) => p === '*' || p === 'gg:*');
		if (hasWildcardBase) {
			// All other parts must be plain exclusions (no wildcards in the exclusion)
			const otherParts = parts.filter((p) => p !== '*' && p !== 'gg:*');
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

	// ─── Inline SVG icons ────────────────────────────────────────────────────
	// All icons use currentColor so they inherit the namespace color on log rows
	// or the green tint on sentinel keep buttons.
	const SVG_ATTR = `viewBox="0 0 12 12" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`;

	/** Eye with diagonal slash — hide from view (Layer 2 / gg-show) */
	const ICON_HIDE =
		`<svg ${SVG_ATTR}>` +
		`<path d="M1 6 C2.5 2.5 9.5 2.5 11 6 C9.5 9.5 2.5 9.5 1 6"/>` +
		`<circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none"/>` +
		`<line x1="9.5" y1="1.5" x2="2.5" y2="10.5"/>` +
		`</svg>`;

	/** Trash can — drop from buffer (Layer 1 / gg-keep) */
	const ICON_DROP =
		`<svg ${SVG_ATTR}>` +
		`<line x1="2" y1="3.5" x2="10" y2="3.5"/>` +
		`<path d="M4.5 3.5V2.5h3v1"/>` +
		`<path d="M3 3.5l.5 7h5l.5-7"/>` +
		`<line x1="5" y1="5.5" x2="5" y2="9"/>` +
		`<line x1="7" y1="5.5" x2="7" y2="9"/>` +
		`</svg>`;

	/** Plus inside a circle — keep in buffer (Layer 1 / gg-keep) */
	const ICON_KEEP =
		`<svg ${SVG_ATTR}>` +
		`<circle cx="6" cy="6" r="4.5"/>` +
		`<line x1="6" y1="3.5" x2="6" y2="8.5"/>` +
		`<line x1="3.5" y1="6" x2="8.5" y2="6"/>` +
		`</svg>`;

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
	.gg-ns-hide,
	.gg-ns-drop {
		all: unset;
		cursor: pointer;
		opacity: 0;
		display: inline-flex;
		align-items: center;
		padding: 2px 3px;
		border-radius: 3px;
		transition: opacity 0.15s, background 0.1s;
		flex-shrink: 0;
	}
	.gg-ns-hide svg,
	.gg-ns-drop svg,
	.gg-sentinel-keep svg {
		pointer-events: none;
	}
		.gg-log-ns:hover .gg-ns-hide,
		.gg-log-ns:hover .gg-ns-drop {
			opacity: 0.35;
		}
		.gg-ns-hide:hover {
			opacity: 1 !important;
			background: rgba(0,0,0,0.08);
		}
		.gg-ns-drop:hover {
			opacity: 1 !important;
			background: rgba(200,50,0,0.12);
		}
	/* Sentinel section: collapsible above log container */
	.gg-sentinel-section {
		flex-shrink: 0;
		background: #f9f9f9;
		border-bottom: 2px solid rgba(0,0,0,0.1);
	}
	.gg-sentinel-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		cursor: pointer;
		font-size: 11px;
		opacity: 0.6;
		user-select: none;
	}
	.gg-sentinel-header:hover {
		opacity: 1;
		background: rgba(0,0,0,0.03);
	}
	.gg-sentinel-toggle {
		font-size: 10px;
	}
	.gg-sentinel-rows {
		max-height: 120px;
		overflow-y: auto;
	}
	.gg-sentinel-rows.collapsed {
		display: none;
	}
	.gg-sentinel-row {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 5px 10px 4px;
		border-bottom: 1px solid rgba(0,0,0,0.04);
		color: #888;
		font-family: monospace;
		font-size: 12px;
	}
	.gg-sentinel-row:last-child {
		border-bottom: none;
	}
	.gg-sentinel-keep {
		all: unset;
		cursor: pointer;
		color: #4caf50;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		padding: 2px 3px;
		border-radius: 3px;
		transition: background 0.1s;
	}
	.gg-sentinel-keep:hover {
		background: rgba(76,175,80,0.15);
	}
	.gg-sentinel-ns {
		font-weight: bold;
		color: #777;
	}
	.gg-sentinel-count {
		color: #999;
		flex-shrink: 0;
		white-space: nowrap;
	}
	.gg-sentinel-preview {
		color: #aaa;
		font-style: italic;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 1;
	}
	/* Pipeline row */
	.gg-pipeline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px;
		padding: 3px 2px;
		flex-shrink: 0;
		margin-bottom: 2px;
	}
	.gg-pipeline-arrow {
		font-size: 11px;
		opacity: 0.35;
		flex-shrink: 0;
		user-select: none;
	}
	.gg-pipeline-node {
		font-size: 11px;
		font-family: monospace;
		background: rgba(0,0,0,0.06);
		border-radius: 4px;
		padding: 2px 6px;
		white-space: nowrap;
		color: #444;
		border: none;
		cursor: default;
	}
	button.gg-pipeline-node {
		cursor: pointer;
	}
	button.gg-pipeline-node:hover {
		background: rgba(0,0,0,0.11);
	}
	.gg-buf-size-input {
		width: 5em;
		font-family: monospace;
		font-size: 11px;
		padding: 1px 4px;
		border: 1px solid rgba(0,0,0,0.25);
		border-radius: 3px;
		background: #fff;
	}
	.gg-pipeline-handle {
		all: unset;
		font-size: 10px;
		font-family: monospace;
		color: #888;
		cursor: pointer;
		padding: 1px 5px;
		border-radius: 3px;
		border: 1px solid rgba(0,0,0,0.15);
		white-space: nowrap;
		transition: background 0.1s, color 0.1s;
		user-select: none;
	}
	.gg-pipeline-handle:hover,
	.gg-pipeline-handle.active {
		background: rgba(0,0,0,0.08);
		color: #222;
	}
	.gg-pipeline-handle.active {
		border-color: rgba(0,0,0,0.3);
	}
	/* Pipeline panels (keep / show) */
	.gg-pipeline-panel {
		flex-shrink: 0;
		margin-bottom: 4px;
	}
	.gg-pipeline-panel-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 2px 4px;
	}
	.gg-filter-label {
		font-size: 11px;
		opacity: 0.6;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.gg-keep-input,
	.gg-show-input {
		flex: 1;
		min-width: 0;
		padding: 3px 6px;
		font-family: monospace;
		font-size: 13px;
		border: 1px solid rgba(0,0,0,0.2);
		border-radius: 3px;
		background: transparent;
	}
	.gg-filter-count {
		font-size: 11px;
		opacity: 0.5;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.gg-filter-details-body {
		background: #f5f5f5;
		padding: 8px 10px;
		border-radius: 4px;
		margin-bottom: 4px;
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
		<div class="gg-pipeline">
		<span class="gg-pipeline-node gg-pipeline-recv" title="Total loggs received by gg"></span>
		<span class="gg-pipeline-arrow">→</span>
		<button class="gg-pipeline-handle gg-pipeline-keep-handle" title="Edit keep filter (Layer 1: ring buffer gate)">keep</button>
		<span class="gg-pipeline-arrow">→</span>
		<button class="gg-pipeline-node gg-pipeline-buf" title="Click to change buffer size"></button>
		<span class="gg-pipeline-arrow">→</span>
		<button class="gg-pipeline-handle gg-pipeline-show-handle" title="Edit show filter (Layer 2: display filter)">show</button>
		<span class="gg-pipeline-arrow">→</span>
		<span class="gg-pipeline-node gg-pipeline-vis" title="Loggs currently visible"></span>
		</div>
		<div class="gg-pipeline-panel gg-keep-panel" style="display:none;">
			<div class="gg-pipeline-panel-header">
				<span class="gg-filter-label">Keep:</span>
				<input class="gg-keep-input" type="text" value="${escapeHtml(keepPattern)}" placeholder="gg:*" title="gg-keep: which loggs enter the ring buffer">
				<span class="gg-keep-filter-summary gg-filter-count"></span>
			</div>
			<div class="gg-keep-filter-panel gg-filter-details-body"></div>
		</div>
		<div class="gg-pipeline-panel gg-show-panel" style="display:none;">
			<div class="gg-pipeline-panel-header">
				<span class="gg-filter-label">Show:</span>
				<input class="gg-show-input" type="text" value="${escapeHtml(filterPattern)}" placeholder="gg:*" title="gg-show: which kept loggs to display">
				<span class="gg-filter-summary gg-filter-count"></span>
			</div>
			<div class="gg-filter-panel gg-filter-details-body"></div>
		</div>
				<div class="gg-settings-panel"></div>
				<div class="gg-sentinel-section" style="display: none;"></div>
	
				<div class="gg-log-container" style="flex: 1; overflow-y: auto; overflow-x: hidden; font-family: monospace; font-size: 12px; touch-action: pan-y; overscroll-behavior: contain;"></div>
				<div class="gg-toast"></div>
				<iframe class="gg-editor-iframe" hidden title="open-in-editor"></iframe>
			</div>
		`;
	}

	function applyPatternFromInput(value: string) {
		filterPattern = value || 'gg:*';
		localStorage.setItem(SHOW_KEY, filterPattern);
		// Sync enabledNamespaces from the new pattern
		const allNamespaces = getAllCapturedNamespaces();
		enabledNamespaces.clear();
		const effectivePattern = filterPattern || 'gg:*';
		allNamespaces.forEach((ns) => {
			if (namespaceMatchesPattern(ns, effectivePattern)) {
				enabledNamespaces.add(ns);
			}
		});
		// Sync toolbar Show input value
		if ($el) {
			const showInput = $el.find('.gg-show-input').get(0) as HTMLInputElement | undefined;
			if (showInput && document.activeElement !== showInput) {
				showInput.value = filterPattern;
			}
		}
		renderFilterUI();
		renderLogs();
	}

	function applyKeepPatternFromInput(value: string) {
		keepPattern = value || 'gg:*';
		localStorage.setItem(KEEP_KEY, keepPattern);
		renderKeepUI();
		scheduleSentinelRender();
	}

	function wireUpFilterUI() {
		if (!$el) return;

		const filterPanel = $el.find('.gg-filter-panel').get(0) as HTMLElement;
		if (!filterPanel) return;

		renderFilterUI();

		// Show handle toggles the show panel
		const showHandle = $el.find('.gg-pipeline-show-handle').get(0) as HTMLElement | undefined;
		const showPanel = $el.find('.gg-show-panel').get(0) as HTMLElement | undefined;
		if (showHandle && showPanel) {
			showHandle.addEventListener('click', () => {
				const open = showPanel.style.display !== 'none';
				showPanel.style.display = open ? 'none' : '';
				showHandle.classList.toggle('active', !open);
				// Close keep panel when opening show
				if (!open) {
					const keepPanel = $el?.find('.gg-keep-panel').get(0) as HTMLElement | undefined;
					const keepHandle = $el?.find('.gg-pipeline-keep-handle').get(0) as
						| HTMLElement
						| undefined;
					if (keepPanel) keepPanel.style.display = 'none';
					if (keepHandle) keepHandle.classList.remove('active');
				}
			});
		}

		// Wire up the Show input (blur or Enter)
		const showInput = $el.find('.gg-show-input').get(0) as HTMLInputElement | undefined;
		if (showInput) {
			showInput.addEventListener('blur', () => {
				applyPatternFromInput(showInput.value);
			});
			showInput.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					applyPatternFromInput(showInput.value);
					showInput.blur();
				}
			});
		}

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
				localStorage.setItem(SHOW_KEY, filterPattern);
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

	/** Update the three pipeline node labels with current counts. */
	function renderPipelineUI() {
		if (!$el) return;

		const keptNs = allNamespacesSet.size;
		const droppedNs = droppedNamespaces.size;
		const totalNs = keptNs + droppedNs;
		const visNs = enabledNamespaces.size;

		// recv node: "N total loggs" (no ns count — it moves to the keep button)
		const recvNode = $el.find('.gg-pipeline-recv').get(0) as HTMLElement | undefined;
		if (recvNode) {
			recvNode.textContent = `${receivedTotal} total loggs`;
		}

		// keep handle: "keep N/N namespaces" (kept ns / total ns ever seen)
		const keepHandle = $el.find('.gg-pipeline-keep-handle').get(0) as HTMLElement | undefined;
		if (keepHandle) {
			const countStr = totalNs ? ` ${keptNs}/${totalNs} namespaces` : '';
			// Preserve active class — only update text content
			keepHandle.textContent = `keep${countStr}`;
		}

		// buf node: buffer.size / buffer.capacity (no ns count — moved to keep button)
		const bufNode = $el.find('.gg-pipeline-buf').get(0) as HTMLElement | undefined;
		if (bufNode) {
			const bufSize = buffer.size;
			const bufCap = buffer.capacity;
			const full = bufSize >= bufCap;
			bufNode.textContent = full ? `${bufSize}/${bufCap} ⚠` : `${bufSize}/${bufCap}`;
			bufNode.style.color = full ? '#b94' : '';
		}

		// show handle: "show N/N namespaces" (visible ns / kept ns)
		const showHandle = $el.find('.gg-pipeline-show-handle').get(0) as HTMLElement | undefined;
		if (showHandle) {
			const countStr = keptNs ? ` ${visNs}/${keptNs} namespaces` : '';
			showHandle.textContent = `show${countStr}`;
		}

		// vis node: "N loggs shown" (no ns count — moved to show button)
		const visNode = $el.find('.gg-pipeline-vis').get(0) as HTMLElement | undefined;
		if (visNode) {
			visNode.textContent = `${filteredIndices.length} loggs shown`;
		}
	}

	function renderFilterUI() {
		if (!$el) return;

		renderPipelineUI();

		const allNamespaces = getAllCapturedNamespaces();
		const enabledCount = enabledNamespaces.size;
		const totalCount = allNamespaces.length;

		// Sync input value (may have changed via hide/undo/right-click)
		const showInput = $el.find('.gg-show-input').get(0) as HTMLInputElement | undefined;
		if (showInput && document.activeElement !== showInput) showInput.value = filterPattern;

		// Update count in summary
		const filterSummary = $el.find('.gg-filter-summary').get(0) as HTMLElement;
		if (filterSummary) filterSummary.textContent = `${enabledCount}/${totalCount}`;

		// Always render panel body — <details> open state handles visibility
		const filterPanel = $el.find('.gg-filter-panel').get(0) as HTMLElement;
		if (!filterPanel) return;

		const simple = isSimplePattern(filterPattern);
		const effectivePattern = filterPattern || 'gg:*';

		if (simple && allNamespaces.length > 0) {
			const allChecked = enabledCount === totalCount;
			const allEntries = buffer.getEntries();
			const nsCounts = new Map<string, number>();
			allEntries.forEach((entry: CapturedEntry) => {
				nsCounts.set(entry.namespace, (nsCounts.get(entry.namespace) || 0) + 1);
			});
			const sortedAll = [...allNamespaces].sort(
				(a, b) => (nsCounts.get(b) || 0) - (nsCounts.get(a) || 0)
			);
			const displayed = sortedAll.slice(0, 5);
			const displayedSet = new Set(displayed);
			const others = allNamespaces.filter((ns) => !displayedSet.has(ns));
			const otherChecked = others.some((ns) => enabledNamespaces.has(ns));
			const otherCount = others.reduce((sum, ns) => sum + (nsCounts.get(ns) || 0), 0);

			filterPanel.innerHTML =
				`<div style="font-size: 11px; opacity: 0.6; margin-bottom: 6px;">Layer 2: controls which kept loggs are displayed.</div>` +
				`<div class="gg-filter-checkboxes">` +
				`<label class="gg-filter-checkbox" style="font-weight: bold;"><input type="checkbox" class="gg-all-checkbox" ${allChecked ? 'checked' : ''}><span>ALL</span></label>` +
				displayed
					.map((ns) => {
						const checked = namespaceMatchesPattern(ns, effectivePattern);
						return `<label class="gg-filter-checkbox"><input type="checkbox" class="gg-ns-checkbox" data-namespace="${escapeHtml(ns)}" ${checked ? 'checked' : ''}><span>${escapeHtml(ns)} (${nsCounts.get(ns) || 0})</span></label>`;
					})
					.join('') +
				(others.length > 0
					? `<label class="gg-filter-checkbox" style="opacity: 0.7;"><input type="checkbox" class="gg-other-checkbox" ${otherChecked ? 'checked' : ''} data-other-namespaces='${JSON.stringify(others)}'><span>other (${otherCount})</span></label>`
					: '') +
				`</div>`;
		} else if (!simple) {
			filterPanel.innerHTML = `<div style="opacity: 0.6; font-size: 11px;">⚠️ Complex pattern — edit directly in the input above</div>`;
		} else {
			filterPanel.innerHTML = '';
		}
	}

	/** Render the Keep filter UI (count + panel body) */
	function renderKeepUI() {
		if (!$el) return;

		renderPipelineUI();

		const droppedCount = droppedNamespaces.size;
		const keptCount = allNamespacesSet.size;
		const totalCount = keptCount + droppedCount;

		// Sync input value
		const keepInput = $el.find('.gg-keep-input').get(0) as HTMLInputElement | undefined;
		if (keepInput && document.activeElement !== keepInput) keepInput.value = keepPattern;

		// Update count in summary (keep panel header)
		const keepSummary = $el.find('.gg-keep-filter-summary').get(0) as HTMLElement;
		if (keepSummary) keepSummary.textContent = `${keptCount}/${totalCount}`;

		// Always render panel body — <details> open state handles visibility
		const keepPanel = $el.find('.gg-keep-filter-panel').get(0) as HTMLElement;
		if (!keepPanel) return;

		const simple = isSimplePattern(keepPattern);
		const allKept = [...allNamespacesSet].sort();
		const allDropped = [...droppedNamespaces.keys()].sort();
		// Also extract namespaces explicitly excluded in keepPattern itself — these may
		// never have sent a logg so they won't be in allNamespacesSet or droppedNamespaces
		const patternExcluded = (keepPattern || 'gg:*')
			.split(',')
			.map((p) => p.trim())
			.filter((p) => p.startsWith('-') && p.length > 1)
			.map((p) => p.slice(1));
		const allNs = [...new Set([...allKept, ...allDropped, ...patternExcluded])];

		if (simple && allNs.length > 0) {
			const allChecked = droppedCount === 0;
			const effectiveKeep = keepPattern || 'gg:*';

			// Count loggs per namespace (kept + dropped combined for context)
			const allEntries = buffer.getEntries();
			const nsCounts = new Map<string, number>();
			allEntries.forEach((entry: CapturedEntry) => {
				nsCounts.set(entry.namespace, (nsCounts.get(entry.namespace) || 0) + 1);
			});
			// Also add dropped counts
			droppedNamespaces.forEach((info, ns) => {
				nsCounts.set(ns, (nsCounts.get(ns) || 0) + info.total);
			});

			const sorted = allNs.sort((a, b) => (nsCounts.get(b) || 0) - (nsCounts.get(a) || 0));
			const displayed = sorted.slice(0, 5);
			const displayedSet = new Set(displayed);
			const others = allNs.filter((ns) => !displayedSet.has(ns));
			const otherKept = others.filter((ns) => namespaceMatchesPattern(ns, effectiveKeep));
			const otherCount = others.reduce((sum, ns) => sum + (nsCounts.get(ns) || 0), 0);

			keepPanel.innerHTML =
				`<div style="font-size: 11px; opacity: 0.6; margin-bottom: 6px;">Layer 1: controls which loggs enter the ring buffer.</div>` +
				`<div class="gg-filter-checkboxes">` +
				`<label class="gg-filter-checkbox" style="font-weight: bold;"><input type="checkbox" class="gg-keep-all-checkbox" ${allChecked ? 'checked' : ''}><span>ALL</span></label>` +
				displayed
					.map((ns) => {
						const checked = namespaceMatchesPattern(ns, effectiveKeep);
						return `<label class="gg-filter-checkbox"><input type="checkbox" class="gg-keep-ns-checkbox" data-namespace="${escapeHtml(ns)}" ${checked ? 'checked' : ''}><span>${escapeHtml(ns)} (${nsCounts.get(ns) || 0})</span></label>`;
					})
					.join('') +
				(others.length > 0
					? `<label class="gg-filter-checkbox" style="opacity: 0.7;"><input type="checkbox" class="gg-keep-other-checkbox" ${otherKept.length > 0 ? 'checked' : ''} data-other-namespaces='${JSON.stringify(others)}'><span>other (${otherCount})</span></label>`
					: '') +
				`</div>`;
		} else if (!simple) {
			keepPanel.innerHTML = `<div style="opacity: 0.6; font-size: 11px;">⚠️ Complex pattern — edit directly in the input above</div>`;
		} else {
			keepPanel.innerHTML = '';
		}
	}

	/** Schedule a debounced re-render of the sentinel section (via rAF) */
	function scheduleSentinelRender() {
		if (sentinelRenderPending) return;
		sentinelRenderPending = true;
		requestAnimationFrame(() => {
			sentinelRenderPending = false;
			renderSentinelSection();
		});
	}

	/** Render the dropped-namespace sentinel section above the log container */
	function renderSentinelSection() {
		if (!$el) return;
		const sentinelSection = $el.find('.gg-sentinel-section').get(0) as HTMLElement | undefined;
		if (!sentinelSection) return;

		if (droppedNamespaces.size === 0) {
			sentinelSection.style.display = 'none';
			sentinelSection.innerHTML = '';
			return;
		}

		// Sort by total dropped count descending (noisiest first)
		const sorted = [...droppedNamespaces.values()].sort((a, b) => b.total - a.total);
		const total = sorted.reduce((sum, i) => sum + i.total, 0);

		// Header: "▼ Dropped: 3 namespaces, 47 loggs" — click to collapse
		const arrow = sentinelExpanded ? '▼' : '▶';
		const headerText = `${sorted.length} dropped namespace${sorted.length === 1 ? '' : 's'}, ${total} logg${total === 1 ? '' : 's'}`;
		let html = `<div class="gg-sentinel-header"><span class="gg-sentinel-toggle">${arrow}</span> ${escapeHtml(headerText)}</div>`;
		html += `<div class="gg-sentinel-rows${sentinelExpanded ? '' : ' collapsed'}">`;

		for (const info of sorted) {
			const ns = escapeHtml(info.namespace);
			const typeEntries = Object.entries(info.byType);
			const breakdown =
				typeEntries.length > 1 ? ` (${typeEntries.map(([t, n]) => `${n} ${t}`).join(', ')})` : '';
			const countStr = `${info.total} logg${info.total === 1 ? '' : 's'}${breakdown}`;

			let previewStr = '';
			if (info.preview.args && info.preview.args.length > 0) {
				const raw = info.preview.args
					.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
					.join(' ');
				previewStr = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
			}

			html +=
				`<div class="gg-sentinel-row" data-namespace="${ns}">` +
				`<button class="gg-sentinel-keep" data-namespace="${ns}" title="Keep this namespace (start capturing its loggs)">${ICON_KEEP}</button>` +
				`<span class="gg-sentinel-ns">DROPPED:${ns}</span>` +
				`<span class="gg-sentinel-count">${escapeHtml(countStr)}</span>` +
				(previewStr
					? `<span class="gg-sentinel-preview">\u21b3 ${escapeHtml(previewStr)}</span>`
					: '') +
				`</div>`;
		}

		html += `</div>`;
		sentinelSection.innerHTML = html;
		sentinelSection.style.display = 'block';

		// Update keep UI summary too
		renderKeepUI();
	}

	/** Wire up the Keep input + sentinel section */
	function wireUpKeepUI() {
		if (!$el) return;

		// Keep handle toggles the keep panel
		const keepHandle = $el.find('.gg-pipeline-keep-handle').get(0) as HTMLElement | undefined;
		const keepPanelEl = $el.find('.gg-keep-panel').get(0) as HTMLElement | undefined;
		if (keepHandle && keepPanelEl) {
			keepHandle.addEventListener('click', () => {
				const open = keepPanelEl.style.display !== 'none';
				keepPanelEl.style.display = open ? 'none' : '';
				keepHandle.classList.toggle('active', !open);
				// Close show panel when opening keep
				if (!open) {
					const showPanel = $el?.find('.gg-show-panel').get(0) as HTMLElement | undefined;
					const showHandle = $el?.find('.gg-pipeline-show-handle').get(0) as
						| HTMLElement
						| undefined;
					if (showPanel) showPanel.style.display = 'none';
					if (showHandle) showHandle.classList.remove('active');
				}
			});
		}

		// Buf node click: replace node text with an inline input to change capacity
		const bufNode = $el.find('.gg-pipeline-buf').get(0) as HTMLElement | undefined;
		if (bufNode) {
			bufNode.addEventListener('click', () => {
				// Already editing?
				if (bufNode.querySelector('.gg-buf-size-input')) return;
				const current = buffer.capacity;
				const input = document.createElement('input');
				input.type = 'number';
				input.className = 'gg-buf-size-input';
				input.value = String(current);
				input.min = '100';
				input.max = '100000';
				input.title = 'Buffer capacity (Enter to apply, Escape to cancel)';
				bufNode.textContent = '';
				bufNode.appendChild(input);
				input.focus();
				input.select();

				const restore = () => {
					input.remove();
					renderPipelineUI(); // restores text content
				};
				const apply = () => {
					const val = parseInt(input.value, 10);
					if (!isNaN(val) && val > 0 && val !== current) {
						buffer.resize(val);
						localStorage.setItem(BUFFER_CAP_KEY, String(val));
						renderLogs();
					}
					restore();
				};
				input.addEventListener('blur', apply);
				input.addEventListener('keydown', (e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						input.blur();
					}
					if (e.key === 'Escape') {
						input.removeEventListener('blur', apply);
						restore();
					}
				});
				// Stop click from immediately re-triggering
				input.addEventListener('click', (e) => e.stopPropagation());
			});
		}

		const keepInput = $el.find('.gg-keep-input').get(0) as HTMLInputElement | undefined;

		if (keepInput) {
			keepInput.addEventListener('blur', () => {
				applyKeepPatternFromInput(keepInput.value);
			});
			keepInput.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					applyKeepPatternFromInput(keepInput.value);
					keepInput.blur();
				}
			});
		}

		// Wire up sentinel section: collapse toggle + [+] keep buttons
		const sentinelSection = $el.find('.gg-sentinel-section').get(0) as HTMLElement | undefined;
		if (sentinelSection) {
			sentinelSection.addEventListener('click', (e: MouseEvent) => {
				const target = e.target as HTMLElement;

				// Header click: toggle collapse
				if (target?.closest?.('.gg-sentinel-header')) {
					sentinelExpanded = !sentinelExpanded;
					renderSentinelSection();
					return;
				}

				const keepBtn = target?.closest?.('.gg-sentinel-keep') as HTMLElement | null;
				if (keepBtn) {
					const namespace = keepBtn.getAttribute('data-namespace');
					if (!namespace) return;

					const info = droppedNamespaces.get(namespace);
					if (!info) return;

					const previousKeep = keepPattern || 'gg:*';

					// Remove the exact exclusion for this namespace from keepPattern.
					// If no exclusion exists (Case B: namespace simply not included), add it.
					const currentKeep = keepPattern || 'gg:*';
					const exclusion = `-${namespace}`;
					const parts = currentKeep
						.split(',')
						.map((p) => p.trim())
						.filter(Boolean);
					const hasExclusion = parts.includes(exclusion);
					if (hasExclusion) {
						keepPattern = parts.filter((p) => p !== exclusion).join(',') || 'gg:*';
					} else {
						// No explicit exclusion — add an inclusion for the exact namespace
						keepPattern = parts.some((p) => !p.startsWith('-'))
							? `${currentKeep},${namespace}`
							: `gg:*,${namespace}`;
					}
					keepPattern = simplifyPattern(keepPattern);
					localStorage.setItem(KEEP_KEY, keepPattern);

					// Sync keep input
					if (keepInput) keepInput.value = keepPattern;

					// Remove from droppedNamespaces map so sentinel disappears immediately
					droppedNamespaces.delete(namespace);

					renderKeepUI();
					renderSentinelSection();

					// Show keep toast for undo / segment broadening
					showKeepToast(namespace, previousKeep, info);
				}
			});
		}

		// Wire up Keep panel checkboxes
		const keepPanel = $el.find('.gg-keep-filter-panel').get(0) as HTMLElement;
		if (keepPanel) {
			keepPanel.addEventListener('change', (e: Event) => {
				const target = e.target as HTMLInputElement;

				if (target.classList.contains('gg-keep-all-checkbox')) {
					const allNs = [...allNamespacesSet, ...droppedNamespaces.keys()];
					if (target.checked) {
						// Keep all: remove all exclusions
						keepPattern = 'gg:*';
						droppedNamespaces.clear();
					} else {
						// Drop all
						const exclusions = allNs.map((ns) => `-${ns}`).join(',');
						keepPattern = `gg:*,${exclusions}`;
						keepPattern = simplifyPattern(keepPattern) || 'gg:*';
					}
					localStorage.setItem(KEEP_KEY, keepPattern);
					renderKeepUI();
					renderLogs();
					renderSentinelSection();
					return;
				}

				if (target.classList.contains('gg-keep-other-checkbox')) {
					const otherNs = JSON.parse(
						target.getAttribute('data-other-namespaces') || '[]'
					) as string[];
					otherNs.forEach((ns) => toggleKeepNamespace(ns, target.checked));
					renderKeepUI();
					renderLogs();
					renderSentinelSection();
					return;
				}

				if (target.classList.contains('gg-keep-ns-checkbox')) {
					const namespace = target.getAttribute('data-namespace');
					if (!namespace) return;
					toggleKeepNamespace(namespace, target.checked);
					renderKeepUI();
					renderLogs();
					renderSentinelSection();
				}
			});
		}

		renderKeepUI();
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
			const nativeConsoleSection = `
				<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #ddd;">
					<div class="gg-settings-label">Native Console Output</div>
					<div style="font-size: 11px; opacity: 0.7; margin-bottom: 8px;">
						When enabled, loggs shown in the GG panel are also output to the browser's native console (filtered by the Show pattern).
					</div>
					<label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px;">
						<input type="checkbox" class="gg-console-toggle" ${ggConsoleEnabled ? 'checked' : ''}>
						Native console output
					</label>
					${ggConsoleEnabled ? `<div style="font-size: 10px; opacity: 0.5; margin-top: 4px;">Disable to silence gg loggs in DevTools console.</div>` : ''}
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
			// Native Console: gg-console toggle
			if (target.classList.contains('gg-console-toggle')) {
				const checked = (target as HTMLInputElement).checked;
				ggConsoleEnabled = checked;
				localStorage.setItem(CONSOLE_KEY, String(checked));
				// Update the debug factory's enabled pattern immediately
				import('../debug/index.js').then(({ default: dbg }) => {
					try {
						const pattern = ggConsoleEnabled ? filterPattern || 'gg:*' : '';
						dbg.enable(pattern);
					} catch {
						// ignore
					}
				});
				renderSettingsUI();
			}
		});
	}

	function wireUpButtons() {
		if (!$el) return;

		$el.find('.gg-clear-btn').on('click', () => {
			buffer.clear();
			allNamespacesSet.clear();
			droppedNamespaces.clear();
			renderLogs();
			renderSentinelSection();
			renderKeepUI();
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
	/** Build clickable segment HTML for a namespace (shared by hide/drop toasts) */
	function buildToastNsHTML(namespace: string): string {
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
		let nsHTML = '';
		for (let i = 0; i < segments.length; i++) {
			let segFilter = '';
			for (let j = 0; j <= i; j++) {
				segFilter += segments[j];
				if (j < i) segFilter += delimiters[j];
				else if (j < segments.length - 1) segFilter += delimiters[j] + '*';
			}
			nsHTML += `<span class="gg-toast-segment" data-filter="${escapeHtml(segFilter)}">${escapeHtml(segments[i])}</span>`;
			if (i < segments.length - 1)
				nsHTML += `<span class="gg-toast-delim">${escapeHtml(delimiters[i])}</span>`;
		}
		return nsHTML;
	}

	function showHideToast(namespace: string, previousPattern: string) {
		if (!$el) return;
		toastMode = 'hide';
		lastHiddenPattern = previousPattern;

		const toast = $el.find('.gg-toast').get(0) as HTMLElement;
		if (!toast) return;

		const nsHTML = buildToastNsHTML(namespace);
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
			`Click a segment above to hide all matching namespaces (e.g. click "api" to hide api/*). ` +
			`Tip: you can also right-click any segment in the log to hide it directly.` +
			`</div>`;

		toast.classList.add('visible');
		if (showExplanation) hasSeenToastExplanation = true;
	}

	function showDropToast(namespace: string, previousKeep: string) {
		if (!$el) return;
		toastMode = 'drop';
		lastDroppedPattern = previousKeep;

		const toast = $el.find('.gg-toast').get(0) as HTMLElement;
		if (!toast) return;

		const nsHTML = buildToastNsHTML(namespace);
		const showExplanation = !hasSeenToastExplanation;

		toast.innerHTML =
			`<button class="gg-toast-btn gg-toast-dismiss" title="Dismiss">\u00d7</button>` +
			`<span class="gg-toast-label">Dropped:</span>` +
			`<span class="gg-toast-ns">${nsHTML}</span>` +
			`<span class="gg-toast-actions">` +
			`<button class="gg-toast-btn gg-toast-undo">Undo</button>` +
			`<button class="gg-toast-btn gg-toast-help" title="Toggle help">?</button>` +
			`</span>` +
			`<div class="gg-toast-explanation${showExplanation ? ' visible' : ''}">` +
			`Click a segment above to drop all matching namespaces from the buffer (e.g. click "api" to drop api/*).` +
			`</div>`;

		toast.classList.add('visible');
		if (showExplanation) hasSeenToastExplanation = true;
	}

	function showKeepToast(namespace: string, previousKeep: string, info: DroppedNamespaceInfo) {
		if (!$el) return;
		toastMode = 'keep';
		lastKeptPattern = previousKeep;
		lastKeptNamespaceInfo = { ns: namespace, info };

		const toast = $el.find('.gg-toast').get(0) as HTMLElement;
		if (!toast) return;

		const nsHTML = buildToastNsHTML(namespace);
		const showExplanation = !hasSeenToastExplanation;

		toast.innerHTML =
			`<button class="gg-toast-btn gg-toast-dismiss" title="Dismiss">\u00d7</button>` +
			`<span class="gg-toast-label">Kept:</span>` +
			`<span class="gg-toast-ns">${nsHTML}</span>` +
			`<span class="gg-toast-actions">` +
			`<button class="gg-toast-btn gg-toast-undo">Undo</button>` +
			`<button class="gg-toast-btn gg-toast-help" title="Toggle help">?</button>` +
			`</span>` +
			`<div class="gg-toast-explanation${showExplanation ? ' visible' : ''}">` +
			`Click a segment above to keep all matching namespaces (e.g. click "api" to keep api/*). ` +
			`Only new loggs from this point forward will be captured.` +
			`</div>`;

		toast.classList.add('visible');
		if (showExplanation) hasSeenToastExplanation = true;
	}

	/** Dismiss the toast bar */
	function dismissToast() {
		if (!$el) return;
		const toast = $el.find('.gg-toast').get(0) as HTMLElement;
		if (toast) {
			toast.classList.remove('visible');
		}
		lastHiddenPattern = null;
		lastDroppedPattern = null;
		lastKeptPattern = null;
		lastKeptNamespaceInfo = null;
	}

	/** Undo the last namespace hide, drop, or keep */
	function undoHide() {
		if (!$el) return;

		if (toastMode === 'keep' && lastKeptPattern !== null) {
			// Restore keepPattern
			keepPattern = lastKeptPattern;
			localStorage.setItem(KEEP_KEY, keepPattern);
			const keepInput = $el.find('.gg-keep-input').get(0) as HTMLInputElement | undefined;
			if (keepInput) keepInput.value = keepPattern;
			// Re-insert the sentinel entry so it reappears
			if (lastKeptNamespaceInfo) {
				droppedNamespaces.set(lastKeptNamespaceInfo.ns, lastKeptNamespaceInfo.info);
			}
			dismissToast();
			renderKeepUI();
			renderSentinelSection();
			renderLogs();
		} else if (toastMode === 'drop' && lastDroppedPattern !== null) {
			// Restore keepPattern
			keepPattern = lastDroppedPattern;
			localStorage.setItem(KEEP_KEY, keepPattern);
			const keepInput = $el.find('.gg-keep-input').get(0) as HTMLInputElement | undefined;
			if (keepInput) keepInput.value = keepPattern;
			// Restore enabledNamespaces from current show filter
			enabledNamespaces.clear();
			const effectiveShow = filterPattern || 'gg:*';
			getAllCapturedNamespaces().forEach((ns: string) => {
				if (namespaceMatchesPattern(ns, effectiveShow)) enabledNamespaces.add(ns);
			});
			dismissToast();
			renderKeepUI();
			renderFilterUI();
			renderLogs();
		} else if (toastMode === 'hide' && lastHiddenPattern !== null) {
			// Restore filterPattern
			filterPattern = lastHiddenPattern;
			localStorage.setItem(SHOW_KEY, filterPattern);
			enabledNamespaces.clear();
			const effectivePattern = filterPattern || 'gg:*';
			getAllCapturedNamespaces().forEach((ns: string) => {
				if (namespaceMatchesPattern(ns, effectivePattern)) enabledNamespaces.add(ns);
			});
			dismissToast();
			renderFilterUI();
			renderLogs();
		}
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

			// Segment click: add exclusion to the appropriate layer
			if (target.classList?.contains('gg-toast-segment')) {
				const filter = target.getAttribute('data-filter');
				if (!filter) return;

				const exclusion = `-${filter}`;

				if (toastMode === 'keep') {
					// Broaden the keep: remove all exclusions whose prefix matches `filter`,
					// then add `filter` as an inclusion if pattern has no wildcard base.
					const currentKeep = keepPattern || 'gg:*';
					const keepParts = currentKeep
						.split(',')
						.map((p) => p.trim())
						.filter(Boolean);
					// Remove any exclusion that is a sub-pattern of filter (starts with -filter prefix)
					const narrowed = keepParts.filter((p) => {
						if (!p.startsWith('-')) return true;
						const excl = p.slice(1).replace(/\*$/, '');
						const filterBase = filter.replace(/\*$/, '');
						return !excl.startsWith(filterBase) && !filterBase.startsWith(excl);
					});
					const hasWildcardBase = narrowed.some((p) => p === '*' || p === 'gg:*');
					if (
						!hasWildcardBase &&
						!narrowed.some(
							(p) => !p.startsWith('-') && namespaceMatchesPattern(filter.replace(/\*$/, 'x'), p)
						)
					) {
						narrowed.push(filter);
					}
					keepPattern = simplifyPattern(narrowed.join(',') || 'gg:*');
					localStorage.setItem(KEEP_KEY, keepPattern);
					const keepInput = $el?.find('.gg-keep-input').get(0) as HTMLInputElement | undefined;
					if (keepInput) keepInput.value = keepPattern;
					// Remove all dropped namespaces that now match the new keepPattern
					for (const ns of [...droppedNamespaces.keys()]) {
						if (namespaceMatchesPattern(ns, keepPattern)) {
							droppedNamespaces.delete(ns);
						}
					}
					dismissToast();
					renderKeepUI();
					renderSentinelSection();
					renderLogs();
				} else if (toastMode === 'drop') {
					// Add exclusion to keepPattern (Layer 1)
					const currentKeep = keepPattern || 'gg:*';
					const keepParts = currentKeep.split(',').map((p) => p.trim());
					if (!keepParts.includes(exclusion)) {
						keepPattern = keepParts.some((p) => !p.startsWith('-'))
							? `${currentKeep},${exclusion}`
							: `gg:*,${exclusion}`;
						keepPattern = simplifyPattern(keepPattern);
					}
					localStorage.setItem(KEEP_KEY, keepPattern);
					const keepInput = $el?.find('.gg-keep-input').get(0) as HTMLInputElement | undefined;
					if (keepInput) keepInput.value = keepPattern;
					// Remove newly-dropped namespace from visible list
					// (the segment pattern may match multiple namespaces)
					getAllCapturedNamespaces().forEach((ns) => {
						if (!namespaceMatchesPattern(ns, keepPattern)) {
							enabledNamespaces.delete(ns);
						}
					});
					dismissToast();
					renderKeepUI();
					renderFilterUI();
					renderLogs();
					scheduleSentinelRender();
				} else {
					// toastMode === 'hide': add exclusion to filterPattern (Layer 2)
					const currentPattern = filterPattern || 'gg:*';
					const parts = currentPattern.split(',').map((p) => p.trim());
					if (parts.includes(exclusion)) {
						filterPattern = parts.filter((p) => p !== exclusion).join(',') || 'gg:*';
					} else {
						filterPattern = parts.some((p) => !p.startsWith('-'))
							? `${currentPattern},${exclusion}`
							: `gg:*,${exclusion}`;
					}
					filterPattern = simplifyPattern(filterPattern);
					enabledNamespaces.clear();
					const effectivePattern = filterPattern || 'gg:*';
					getAllCapturedNamespaces().forEach((ns) => {
						if (namespaceMatchesPattern(ns, effectivePattern)) enabledNamespaces.add(ns);
					});
					localStorage.setItem(SHOW_KEY, filterPattern);
					dismissToast();
					renderFilterUI();
					renderLogs();
				}
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

			// Handle reset filter button (shown when all logs filtered out by gg-show)
			if (target?.classList?.contains('gg-reset-filter-btn')) {
				filterPattern = 'gg:*';
				enabledNamespaces.clear();
				getAllCapturedNamespaces().forEach((ns) => enabledNamespaces.add(ns));
				localStorage.setItem(SHOW_KEY, filterPattern);
				renderFilterUI();
				renderLogs();
				return;
			}

			// Handle keep-all button (shown when gg-keep is restrictive and buffer is empty)
			if (target?.classList?.contains('gg-keep-all-btn')) {
				keepPattern = 'gg:*';
				localStorage.setItem(KEEP_KEY, keepPattern);
				const keepInput = $el?.find('.gg-keep-input').get(0) as HTMLInputElement | undefined;
				if (keepInput) keepInput.value = keepPattern;
				renderKeepUI();
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

				localStorage.setItem(SHOW_KEY, filterPattern);
				renderFilterUI();
				renderLogs();
				return;
			}

			// Handle clicking time diff to open in editor
			if (target?.classList?.contains('gg-log-diff') && target.hasAttribute('data-file')) {
				handleNamespaceClick(target);
				return;
			}

			// Handle clicking drop button for namespace (Layer 1: gg-keep)
			const dropBtn = target?.closest?.('.gg-ns-drop') as HTMLElement | null;
			if (dropBtn) {
				const namespace = dropBtn.getAttribute('data-namespace');
				if (!namespace) return;

				const currentKeep = keepPattern || 'gg:*';
				const exclusion = `-${namespace}`;
				const parts = currentKeep.split(',').map((p) => p.trim());
				if (!parts.includes(exclusion)) {
					const previousKeep = keepPattern;
					keepPattern = `${currentKeep},${exclusion}`;
					keepPattern = simplifyPattern(keepPattern);
					localStorage.setItem(KEEP_KEY, keepPattern);
					// Sync keep input
					const keepInput = $el?.find('.gg-keep-input').get(0) as HTMLInputElement | undefined;
					if (keepInput) keepInput.value = keepPattern;
					// Remove from visible loggs (Layer 1 drop hides from display too)
					enabledNamespaces.delete(namespace);
					renderKeepUI();
					renderFilterUI();
					renderLogs();
					scheduleSentinelRender();
					showDropToast(namespace, previousKeep);
				}
				return;
			}

			// Handle clicking hide button for namespace
			const hideBtn = target?.closest?.('.gg-ns-hide') as HTMLElement | null;
			if (hideBtn) {
				const namespace = hideBtn.getAttribute('data-namespace');
				if (!namespace) return;

				// Save current pattern for undo before hiding
				const previousPattern = filterPattern;

				toggleNamespace(namespace, false);
				localStorage.setItem(SHOW_KEY, filterPattern);
				renderFilterUI();
				renderLogs();

				// Show toast with undo option
				showHideToast(namespace, previousPattern);
				return;
			}

			// Clicking background (container or grid, not a log entry) restores show filter
			if (
				filterPattern !== 'gg:*' &&
				(target === containerEl || target?.classList?.contains('gg-log-grid'))
			) {
				filterPattern = 'gg:*';
				enabledNamespaces.clear();
				getAllCapturedNamespaces().forEach((ns) => enabledNamespaces.add(ns));
				localStorage.setItem(SHOW_KEY, filterPattern);
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

				localStorage.setItem(SHOW_KEY, filterPattern);
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
			`<div class="gg-log-ns" style="color: ${color};" data-namespace="${escapeHtml(entry.namespace)}"><span class="gg-ns-text">${nsHTML}</span><button class="gg-ns-drop" data-namespace="${escapeHtml(entry.namespace)}" title="Drop this namespace (stop buffering its loggs)">${ICON_DROP}</button><button class="gg-ns-hide" data-namespace="${escapeHtml(entry.namespace)}" title="Hide this namespace">${ICON_HIDE}</button></div>` +
			`<div class="gg-log-handle"></div>` +
			`</div>` +
			`<div class="gg-log-content"${hasSrcExpr ? ` data-src="${escapeHtml(entry.src!)}"` : ''}>${exprAboveForPrimitives}${argsHTML}${stackHTML}</div>` +
			detailsHTML +
			`</div>`
		);
	}

	/** Update the copy-button count text */
	function updateTruncationBanner() {
		// Truncation info is now shown in the pipeline buffer node (buf/cap ⚠).
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
		(containerDom as HTMLElement & { __ggVirtualCleanup?: () => void }).__ggVirtualCleanup =
			cleanup;

		// Initial render, then scroll to bottom if requested
		virtualizer._willUpdate();
		renderVirtualItems();

		if (scrollToBottom) {
			virtualizer.scrollToIndex(count - 1, { align: 'end' });
		}
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
			renderPipelineUI();
			return;
		}

		// Rebuild filteredIndices from scratch. This is O(buffer.size) with a
		// Set lookup per entry — ~0.1ms for 2000 entries. Always correct even
		// when the buffer wraps and old logical indices shift.
		rebuildFilteredIndices();

		updateCopyCount();
		updateTruncationBanner();
		renderPipelineUI();

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

			// Render first so spacer height is updated, then scroll
			renderVirtualItems();

			if (userNearBottom) {
				virtualizer.scrollToIndex(filteredIndices.length - 1, { align: 'end' });
			}
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

		renderPipelineUI();
		updateCopyCount();
		updateTruncationBanner();

		if (filteredIndices.length === 0) {
			// Tear down virtualizer
			if (virtualizer) {
				const containerDom = logContainer.get(0) as HTMLElement | undefined;
				if (containerDom) {
					const cleanup = (containerDom as HTMLElement & { __ggVirtualCleanup?: () => void })
						.__ggVirtualCleanup;
					if (cleanup) cleanup();
				}
				virtualizer = null;
			}

			const hasFilteredLogs = buffer.size > 0;
			const keepIsRestrictive =
				(keepPattern || 'gg:*') !== 'gg:*' && (keepPattern || 'gg:*') !== '*';
			let message: string;
			let actionButton: string;
			if (hasFilteredLogs) {
				message = `All ${buffer.size} logs filtered out.`;
				actionButton =
					'<button class="gg-reset-filter-btn" style="margin-top: 12px; padding: 10px 20px; cursor: pointer; border: 1px solid #2196F3; background: #2196F3; color: white; border-radius: 6px; font-size: 13px; font-weight: 500; transition: background 0.2s;">Show all logs (gg:*)</button>';
			} else if (keepIsRestrictive) {
				message = 'No loggs kept.';
				actionButton =
					`<button class="gg-keep-all-btn" style="margin-top: 12px; padding: 10px 20px; cursor: pointer; border: 1px solid #4CAF50; background: #4CAF50; color: white; border-radius: 6px; font-size: 13px; font-weight: 500; transition: background 0.2s;">Keep All</button>` +
					`<div style="margin-top: 10px; font-size: 11px; opacity: 0.7;">gg-keep: ${escapeHtml(keepPattern || 'gg:*')}</div>`;
			} else {
				message = 'No loggs captured yet. Call gg() to see output here.';
				actionButton = '';
			}
			logContainer.html(
				`<div style="padding: 20px; text-align: center; opacity: 0.5;">${message}<div>${actionButton}</div></div>`
			);
			return;
		}

		// Build the virtual scroll DOM structure:
		// - .gg-virtual-spacer: sized to total virtual height (provides scrollbar)
		//   - .gg-log-grid: positioned absolutely, translated to visible offset, holds only visible entries
		const gridClasses = `gg-log-grid${showExpressions ? ' gg-show-expr' : ''}`;
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
