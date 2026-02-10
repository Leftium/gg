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

	const plugin = {
		name: 'GG',

		init($container: any) {
			$el = $container;

			// Register the capture hook on gg
			if (gg) {
				gg._onLog = (entry: CapturedEntry) => {
					buffer.push(entry);
					renderLogs();
				};
			}

			// Render initial UI
			$el.html(buildHTML());
			wireUpButtons();
			wireUpExpanders();
			wireUpResize();
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

	function gridColumns(): string {
		const ns = nsColWidth !== null ? `${nsColWidth}px` : 'auto';
		return `auto ${ns} 4px 1fr`;
	}

	function buildHTML(): string {
		return `
			<style>
				.gg-log-grid {
					display: grid;
					grid-template-columns: ${gridColumns()};
					column-gap: 0;
					align-items: baseline;
				}
				.gg-log-grid > * {
					min-width: 0;
					border-bottom: 1px solid rgba(0,0,0,0.05);
				}
				.gg-log-diff {
					text-align: right;
					padding: 4px 8px 4px 0;
				}
				.gg-log-ns {
					font-weight: bold;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
					padding: 4px 8px 4px 0;
				}
				.gg-log-handle {
					grid-column: 3;
					width: 4px;
					cursor: col-resize;
					align-self: stretch;
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
			</style>
			<div class="eruda-gg" style="padding: 10px; height: 100%; display: flex; flex-direction: column; font-size: 14px;">
				<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-shrink: 0;">
					<button class="gg-clear-btn" style="padding: 4px 10px; cursor: pointer;">Clear</button>
					<button class="gg-copy-btn" style="padding: 4px 10px; cursor: pointer;">Copy</button>
					<span class="gg-count" style="margin-left: auto; opacity: 0.6;"></span>
				</div>
				<div class="gg-log-container" style="flex: 1; overflow-y: auto; font-family: monospace; font-size: 12px;"></div>
			</div>
		`;
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
			if (!target?.classList?.contains('gg-expand')) return;

			const index = target.getAttribute('data-index');
			if (!index) return;

			const details = containerEl.querySelector(
				`.gg-details[data-index="${index}"]`
			) as HTMLElement | null;

			if (details) {
				details.style.display = details.style.display === 'none' ? 'block' : 'none';
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

		const entries = buffer.getEntries();
		countSpan.html(`${entries.length} entries`);

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
								return (
									`<span style="color: #888; cursor: pointer; text-decoration: underline;" class="gg-expand" data-index="${uniqueId}">${preview}</span>` +
									`<div class="gg-details" data-index="${uniqueId}" style="display: none; grid-column: 1 / -1; margin: 4px 0 8px 0; padding: 8px; background: #f8f8f8; border-left: 3px solid ${color}; font-size: 11px; overflow-x: auto;"><pre style="margin: 0;">${jsonStr}</pre></div>`
								);
							} else {
								return `<span>${escapeHtml(String(arg))}</span>`;
							}
						})
						.join(' ');
				}

				return (
					`<div class="gg-log-diff" style="color: ${color};">${diff}</div>` +
					`<div class="gg-log-ns" style="color: ${color};">${ns}</div>` +
					`<div class="gg-log-handle"></div>` +
					`<div class="gg-log-content">${argsHTML}</div>`
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
		if (abs >= 86400000) return Math.round(ms / 86400000) + 'd';
		if (abs >= 3600000) return Math.round(ms / 3600000) + 'h';
		if (abs >= 60000) return Math.round(ms / 60000) + 'm';
		if (abs >= 1000) return Math.round(ms / 1000) + 's';
		return ms + 'ms';
	}

	function escapeHtml(text: string): string {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	return plugin;
}
