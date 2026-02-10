import type { GgErudaOptions, CapturedEntry } from './types.js';
import { LogBuffer } from './buffer.js';

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

	const plugin = {
		name: 'GG',

		init($container: LiciaElement) {
			$el = $container;

			// Register the capture hook on gg
			if (gg) {
				gg._onLog = (entry: CapturedEntry) => {
					buffer.push(entry);
					// Add new namespace to enabledNamespaces if it matches the current pattern
					const effectivePattern = filterPattern || 'gg:*';
					if (namespaceMatchesPattern(entry.namespace, effectivePattern)) {
						enabledNamespaces.add(entry.namespace);
					}
					// Update filter UI if expanded (new namespace may have appeared)
					if (filterExpanded) {
						renderFilterUI();
					}
					renderLogs();
				};
			}

			// Load initial filter state
			filterPattern = localStorage.getItem('debug') || '';

			// Render initial UI
			$el.html(buildHTML());
			wireUpButtons();
			wireUpExpanders();
			wireUpResize();
			wireUpFilterUI();
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
			buffer.clear();
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
		const entries = buffer.getEntries();
		const nsSet = new Set<string>();
		entries.forEach((e: CapturedEntry) => nsSet.add(e.namespace));
		return Array.from(nsSet).sort();
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
		// diff | ns | handle | content (× is now inside ns)
		return `auto ${ns} 4px 1fr`;
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
			/* Desktop: hide wrapper divs, show direct children */
			.gg-log-entry {
				display: contents;
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
					text-overflow: ellipsis;
					padding: 4px 8px 4px 0;
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
				}
			/* Make header clickable for filtering when filters are expanded */
			.gg-log-header.clickable {
				cursor: pointer;
			}
			/* Desktop: highlight child elements since header has display: contents */
			.gg-log-header.clickable:hover .gg-log-diff,
			.gg-log-header.clickable:hover .gg-log-ns {
				background: rgba(0,0,0,0.05);
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
			/* Mobile: hover on container since it's not display: contents */
			.gg-log-header.clickable {
				padding: 2px 0;
			}
			.gg-log-header.clickable:hover {
				background: rgba(0,0,0,0.05);
			}
				/* Override desktop child hover on mobile */
				.gg-log-header.clickable:hover .gg-log-diff,
				.gg-log-header.clickable:hover .gg-log-ns {
					background: transparent;
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
		<div class="eruda-gg" style="padding: 10px; height: 100%; display: flex; flex-direction: column; font-size: 14px; touch-action: none; overscroll-behavior: contain;">
			<div class="gg-toolbar">
				<button class="gg-copy-btn">
					<span class="gg-btn-text">Copy</span>
					<span class="gg-btn-icon" title="Copy">📋</span>
				</button>
			<button class="gg-filter-btn" style="text-align: left; white-space: nowrap;">
				<span class="gg-btn-text">Namespaces: </span>
				<span class="gg-btn-icon">NS: </span>
				<span class="gg-filter-summary"></span>
			</button>
				<span class="gg-count" style="opacity: 0.6; white-space: nowrap; flex: 1; text-align: right;"></span>
				<button class="gg-clear-btn">
					<span class="gg-btn-text">Clear</span>
					<span class="gg-btn-icon" title="Clear">⊘</span>
				</button>
			</div>
				<div class="gg-filter-panel"></div>
				<div class="gg-log-container" style="flex: 1; overflow-y: auto; font-family: monospace; font-size: 12px; touch-action: pan-y; overscroll-behavior: contain;"></div>
			</div>
		`;
	}

	function applyPatternFromInput(value: string) {
		filterPattern = value;
		localStorage.setItem('debug', filterPattern);
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

		// Wire up button toggle
		filterBtn.addEventListener('click', () => {
			filterExpanded = !filterExpanded;
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
				localStorage.setItem('debug', filterPattern);
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

				checkboxesHTML = `
				<div class="gg-filter-checkboxes">
					<label class="gg-filter-checkbox" style="font-weight: bold;">
						<input type="checkbox" class="gg-all-checkbox" ${allChecked ? 'checked' : ''}>
						<span>ALL</span>
					</label>
					${allNamespaces
						.map((ns) => {
							// Check if namespace matches the current pattern
							const checked = namespaceMatchesPattern(ns, effectivePattern);
							return `
							<label class="gg-filter-checkbox">
								<input type="checkbox" class="gg-ns-checkbox" data-namespace="${escapeHtml(ns)}" ${checked ? 'checked' : ''}>
								<span>${escapeHtml(ns)}</span>
							</label>
						`;
						})
						.join('')}
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

	function wireUpButtons() {
		if (!$el) return;

		$el.find('.gg-clear-btn').on('click', () => {
			buffer.clear();
			renderLogs();
		});

		$el.find('.gg-copy-btn').on('click', async () => {
			const allEntries = buffer.getEntries();
			// Apply same filtering as renderLogs() - only copy visible entries
			const entries = allEntries.filter((entry: CapturedEntry) =>
				enabledNamespaces.has(entry.namespace)
			);

			const text = entries
				.map((e: CapturedEntry) => {
					// Extract just HH:MM:SS from timestamp (compact for LLMs)
					const time = new Date(e.timestamp).toISOString().slice(11, 19);
					// Trim namespace and strip 'gg:' prefix to save tokens
					const ns = e.namespace.trim().replace(/^gg:/, '');
					// Format args: compact JSON for objects, primitives as-is
					const argsStr = e.args
						.map((arg) => {
							if (typeof arg === 'object' && arg !== null) {
								return JSON.stringify(arg);
							}
							// Strip ANSI escape codes from string args
							return stripAnsi(String(arg));
						})
						.join(' ');
					return `${time} ${ns} ${argsStr}`;
				})
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
	}

	function wireUpExpanders() {
		if (!$el || expanderAttached) return;

		// Use native event delegation on the actual DOM element.
		// Licia's .on() doesn't delegate to children replaced by .html().
		const containerEl = $el.find('.gg-log-container').get(0) as HTMLElement | undefined;
		if (!containerEl) return;

		containerEl.addEventListener('click', (e: MouseEvent) => {
			const target = e.target as HTMLElement;

			// Handle expand/collapse
			if (target?.classList?.contains('gg-expand')) {
				const index = target.getAttribute('data-index');
				if (!index) return;

				const details = containerEl.querySelector(
					`.gg-details[data-index="${index}"]`
				) as HTMLElement | null;

				if (details) {
					details.style.display = details.style.display === 'none' ? 'block' : 'none';
				}
				return;
			}

			// Handle clickable header (when filters expanded)
			// Skip if clicking on resize handle
			if (
				!target?.classList?.contains('gg-log-handle') &&
				target?.closest('.gg-log-header.clickable')
			) {
				const header = target.closest('.gg-log-header.clickable') as HTMLElement;
				const namespace = header.getAttribute('data-namespace');
				if (!namespace) return;

				// Toggle this namespace off
				toggleNamespace(namespace, false);

				// Save to localStorage and re-render
				localStorage.setItem('debug', filterPattern);
				renderFilterUI();
				renderLogs();
			}
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

	function renderLogs() {
		if (!$el) return;

		const logContainer = $el.find('.gg-log-container');
		const countSpan = $el.find('.gg-count');
		if (!logContainer.length || !countSpan.length) return;

		const allEntries = buffer.getEntries();

		// Apply filtering
		const entries = allEntries.filter((entry: CapturedEntry) =>
			enabledNamespaces.has(entry.namespace)
		);

		const countText =
			entries.length === allEntries.length
				? `${entries.length} entries`
				: `${entries.length} / ${allEntries.length} entries`;
		countSpan.html(countText);

		if (entries.length === 0) {
			logContainer.html(
				'<div style="padding: 20px; text-align: center; opacity: 0.5;">No logs captured yet. Call gg() to see output here.</div>'
			);
			return;
		}

		const logsHTML = `<div class="gg-log-grid" style="grid-template-columns: ${gridColumns()};">${entries
			.map((entry: CapturedEntry, index: number) => {
				const color = entry.color || '#0066cc';
				const diff = `+${humanize(entry.diff)}`;
				const ns = escapeHtml(entry.namespace);

				// Format each arg individually - objects are expandable
				let argsHTML = '';
				let detailsHTML = '';
				if (entry.args.length > 0) {
					argsHTML = entry.args
						.map((arg, argIdx) => {
							if (typeof arg === 'object' && arg !== null) {
								// Show expandable object
								const preview = Array.isArray(arg) ? `Array(${arg.length})` : 'Object';
								const jsonStr = escapeHtml(JSON.stringify(arg, null, 2));
								const uniqueId = `${index}-${argIdx}`;
								// Store details separately to render after the row
								detailsHTML += `<div class="gg-details" data-index="${uniqueId}" style="display: none; margin: 4px 0 8px 0; padding: 8px; background: #f8f8f8; border-left: 3px solid ${color}; font-size: 11px; overflow-x: auto;"><pre style="margin: 0;">${jsonStr}</pre></div>`;
								return `<span style="color: #888; cursor: pointer; text-decoration: underline;" class="gg-expand" data-index="${uniqueId}">${preview}</span>`;
							} else {
								// Parse ANSI codes first, then convert URLs to clickable links
								const argStr = String(arg);
								const parsedAnsi = parseAnsiToHtml(argStr);
								// Note: URL linking happens after ANSI parsing, so links work inside colored text
								// This is a simple approach - URLs inside ANSI codes won't be linkified
								// For more complex parsing, we'd need to track ANSI state while matching URLs
								return `<span>${parsedAnsi}</span>`;
							}
						})
						.join(' ');
				}

				// Make header clickable when filters expanded
				const headerClass = filterExpanded ? 'gg-log-header clickable' : 'gg-log-header';
				const headerAttrs = filterExpanded
					? ` data-namespace="${ns}" title="Click to hide this namespace"`
					: '';

				// Add × at start of diff when filters expanded (bold, darker)
				const filterIcon = filterExpanded
					? '<span style="font-weight: bold; color: #000; opacity: 0.6;">× </span>'
					: '';

				// Desktop: grid layout, Mobile: stacked layout
				return (
					`<div class="gg-log-entry">` +
					`<div class="${headerClass}"${headerAttrs}>` +
					`<div class="gg-log-diff" style="color: ${color};">${filterIcon}${diff}</div>` +
					`<div class="gg-log-ns" style="color: ${color};">${ns}</div>` +
					`<div class="gg-log-handle"></div>` +
					`</div>` +
					`<div class="gg-log-content">${argsHTML}</div>` +
					detailsHTML +
					`</div>`
				);
			})
			.join('')}</div>`;

		logContainer.html(logsHTML);

		// Re-wire expanders after rendering
		wireUpExpanders();

		// Auto-scroll to bottom
		const el = logContainer.get(0);
		if (el) el.scrollTop = el.scrollHeight;
	}

	/** Format ms like debug's `ms` package: 0ms, 500ms, 5s, 2m, 1h, 3d */
	function humanize(ms: number): string {
		const abs = Math.abs(ms);
		if (abs >= 86400000) return Math.round(ms / 86400000) + 'd ';
		if (abs >= 3600000) return Math.round(ms / 3600000) + 'h ';
		if (abs >= 60000) return Math.round(ms / 60000) + 'm ';
		if (abs >= 1000) return Math.round(ms / 1000) + 's ';
		return ms + 'ms';
	}

	function escapeHtml(text: string): string {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	/**
	 * Strip ANSI escape codes from text
	 * Removes all ANSI escape sequences like \x1b[...m
	 */
	function stripAnsi(text: string): string {
		// Remove all ANSI escape codes
		return text.replace(/\x1b\[[0-9;]*m/g, '');
	}

	/**
	 * Parse ANSI escape codes and convert to HTML with inline styles
	 * Supports:
	 * - 24-bit RGB: \x1b[38;2;r;g;bm (foreground), \x1b[48;2;r;g;bm (background)
	 * - Reset: \x1b[0m
	 */
	function parseAnsiToHtml(text: string): string {
		// ANSI escape sequence regex
		// Matches: \x1b[38;2;r;g;bm, \x1b[48;2;r;g;bm, \x1b[0m
		const ansiRegex = /\x1b\[([0-9;]+)m/g;

		let html = '';
		let lastIndex = 0;
		let currentFg: string | null = null;
		let currentBg: string | null = null;
		let match;

		while ((match = ansiRegex.exec(text)) !== null) {
			// Add text before this code (with current styling)
			const textBefore = text.slice(lastIndex, match.index);
			if (textBefore) {
				html += wrapWithStyle(escapeHtml(textBefore), currentFg, currentBg);
			}

			// Parse the ANSI code
			const code = match[1];
			const parts = code.split(';').map(Number);

			if (parts[0] === 0) {
				// Reset
				currentFg = null;
				currentBg = null;
			} else if (parts[0] === 38 && parts[1] === 2 && parts.length >= 5) {
				// Foreground RGB: 38;2;r;g;b
				currentFg = `rgb(${parts[2]},${parts[3]},${parts[4]})`;
			} else if (parts[0] === 48 && parts[1] === 2 && parts.length >= 5) {
				// Background RGB: 48;2;r;g;b
				currentBg = `rgb(${parts[2]},${parts[3]},${parts[4]})`;
			}

			lastIndex = ansiRegex.lastIndex;
		}

		// Add remaining text
		const remaining = text.slice(lastIndex);
		if (remaining) {
			html += wrapWithStyle(escapeHtml(remaining), currentFg, currentBg);
		}

		return html || escapeHtml(text);
	}

	/**
	 * Wrap text with inline color styles
	 */
	function wrapWithStyle(text: string, fg: string | null, bg: string | null): string {
		if (!fg && !bg) return text;

		const styles: string[] = [];
		if (fg) styles.push(`color: ${fg}`);
		if (bg) styles.push(`background-color: ${bg}`);

		return `<span style="${styles.join('; ')}">${text}</span>`;
	}

	return plugin;
}
