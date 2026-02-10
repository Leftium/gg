import type { GgErudaOptions, CapturedEntry } from './types.js';
import { LogBuffer } from './buffer.js';

/**
 * Creates the gg Eruda plugin
 *
 * Uses Eruda's plugin API where $el is a jQuery-like (licia) wrapper.
 * Methods: $el.html(), $el.show(), $el.hide(), $el.find(), $el.on()
 */
export function createGgPlugin(options: GgErudaOptions, gg: any) {
	const buffer = new LogBuffer(options.maxEntries ?? 2000);
	// The licia jQuery-like wrapper Eruda passes to init()
	let $el: any = null;
	let expanderAttached = false;
	let resizeAttached = false;
	// null = auto (fit content), number = user-dragged px width
	let nsColWidth: number | null = null;
	// Filter UI state
	let filterExpanded = false;
	let filterPattern = '';
	let enabledNamespaces = new Set<string>();

	const plugin = {
		name: 'GG',

		init($container: any) {
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
			$el.show();
			renderLogs();
		},

		hide() {
			$el.hide();
		},

		destroy() {
			if (gg) {
				gg._onLog = null;
			}
			buffer.clear();
		}
	};

	function loadFilterState() {
		filterPattern = localStorage.getItem('debug') || '';
		// Rebuild enabledNamespaces based on current pattern and captured logs
		const allNamespaces = getAllCapturedNamespaces();
		enabledNamespaces.clear();

		// If no pattern, default to 'gg:*' (show all gg logs)
		const effectivePattern = filterPattern || 'gg:*';

		allNamespaces.forEach((ns) => {
			if (namespaceMatchesPattern(ns, effectivePattern)) {
				enabledNamespaces.add(ns);
			}
		});
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
		if (filterExpanded) {
			// [×] | diff | ns | handle | content
			return `24px auto ${ns} 4px 1fr`;
		} else {
			// diff | ns | handle | content
			return `auto ${ns} 4px 1fr`;
		}
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
				.gg-log-grid > * {
					min-width: 0;
					border-top: 1px solid rgba(0,0,0,0.05);
					align-self: start !important;
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
				.gg-row-filter {
					text-align: center;
					padding: 4px 8px 4px 0;
					cursor: pointer;
					user-select: none;
					opacity: 0.6;
					font-size: 14px;
					align-self: start;
				}
				.gg-row-filter:hover {
					opacity: 1;
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
					font-size: 12px;
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
			</style>
			<div class="eruda-gg" style="padding: 10px; height: 100%; display: flex; flex-direction: column; font-size: 14px;">
				<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-shrink: 0;">
					<button class="gg-clear-btn" style="padding: 4px 10px; cursor: pointer;">Clear</button>
					<button class="gg-copy-btn" style="padding: 4px 10px; cursor: pointer;">Copy</button>
					<button class="gg-filter-btn" style="padding: 4px 10px; cursor: pointer; flex: 1; min-width: 0; text-align: left; font-family: monospace; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">⚙️ Filters: <span class="gg-filter-summary"></span></button>
					<span class="gg-count" style="opacity: 0.6; white-space: nowrap;"></span>
				</div>
				<div class="gg-filter-panel"></div>
				<div class="gg-log-container" style="flex: 1; overflow-y: auto; font-family: monospace; font-size: 12px;"></div>
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

		// Update button summary
		const filterSummary = $el.find('.gg-filter-summary').get(0) as HTMLElement;
		if (filterSummary) {
			const summary = filterPattern || 'gg:*';
			filterSummary.textContent = summary;
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
				checkboxesHTML = `
					<div class="gg-filter-checkboxes">
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
			const entries = buffer.getEntries();
			const text = entries
				.map((e: CapturedEntry) => {
					const timestamp = new Date(e.timestamp).toISOString();
					// Format args: stringify objects, keep primitives as-is
					const argsStr = e.args
						.map((arg) => {
							if (typeof arg === 'object' && arg !== null) {
								return JSON.stringify(arg, null, 2);
							}
							return String(arg);
						})
						.join(' ');
					return `[${timestamp}] ${e.namespace} ${argsStr}`;
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

			// Handle row filter button
			if (target?.classList?.contains('gg-row-filter')) {
				const namespace = target.getAttribute('data-namespace');
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
				if (entry.args.length === 0) {
					argsHTML = '';
				} else {
					argsHTML = entry.args
						.map((arg, argIdx) => {
							if (typeof arg === 'object' && arg !== null) {
								// Show expandable object
								const preview = Array.isArray(arg) ? `Array(${arg.length})` : 'Object';
								const jsonStr = escapeHtml(JSON.stringify(arg, null, 2));
								const uniqueId = `${index}-${argIdx}`;
								// Store details separately to render after the row
								detailsHTML += `<div class="gg-details" data-index="${uniqueId}" style="display: none; grid-column: 1 / -1; margin: 4px 0 8px 0; padding: 8px; background: #f8f8f8; border-left: 3px solid ${color}; font-size: 11px; overflow-x: auto;"><pre style="margin: 0;">${jsonStr}</pre></div>`;
								return `<span style="color: #888; cursor: pointer; text-decoration: underline;" class="gg-expand" data-index="${uniqueId}">${preview}</span>`;
							} else {
								return `<span>${escapeHtml(String(arg))}</span>`;
							}
						})
						.join(' ');
				}

				// Add filter button if expanded
				const filterBtn = filterExpanded
					? `<div class="gg-row-filter" data-namespace="${ns}" title="Hide this namespace">×</div>`
					: '';

				return (
					filterBtn +
					`<div class="gg-log-diff" style="color: ${color};">${diff}</div>` +
					`<div class="gg-log-ns" style="color: ${color};">${ns}</div>` +
					`<div class="gg-log-handle"></div>` +
					`<div class="gg-log-content">${argsHTML}</div>` +
					detailsHTML
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

	return plugin;
}
