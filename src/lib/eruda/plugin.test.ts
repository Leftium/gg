/**
 * Tests for the Phase 2 dropped-namespace tracking in createGgPlugin.
 *
 * The dropped-namespace map is an internal data structure maintained by the
 * keep gate (Layer 1). These tests verify that entries not matching gg-keep
 * are tracked correctly and that the map is cleared on destroy/clear.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CapturedEntry } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal CapturedEntry factory — only fields needed by the keep-gate path */
function makeEntry(namespace: string, overrides: Partial<CapturedEntry> = {}): CapturedEntry {
	return {
		namespace,
		color: '#aabbcc',
		diff: 0,
		message: 'test message',
		args: ['test'],
		timestamp: Date.now(),
		...overrides
	};
}

/**
 * Minimal LiciaElement mock.
 * Captures `.on('click', handler)` calls keyed by selector so tests can
 * trigger button clicks without a real DOM.
 */
function makeMockEl() {
	// Map from selector string → click handler
	const handlers: Record<string, (() => void)[]> = {};

	const findResult = (selector: string) => ({
		on(event: string, handler: () => void) {
			if (event === 'click') {
				handlers[selector] = handlers[selector] ?? [];
				handlers[selector].push(handler);
			}
			return this;
		},
		get(_idx: number) {
			return undefined;
		}
	});

	const $el = {
		html(_content: string) {},
		show() {},
		hide() {},
		find: (selector: string) => findResult(selector),
		/** Fire all click handlers registered for a selector */
		click(selector: string) {
			for (const h of handlers[selector] ?? []) h();
		}
	};

	return $el;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('createGgPlugin — dropped namespace tracking (Phase 2)', () => {
	let storage: Map<string, string>;
	let capturedListener: ((entry: CapturedEntry) => void) | null;
	let plugin: Awaited<ReturnType<typeof import('./plugin.js').createGgPlugin>>;
	let $el: ReturnType<typeof makeMockEl>;

	beforeEach(async () => {
		// Fresh localStorage mock
		storage = new Map();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key)
		});

		// Stub globals that init() touches
		vi.stubGlobal('requestAnimationFrame', (_cb: () => void) => 0);
		vi.stubGlobal('fetch', () => Promise.resolve({ status: 404, text: () => Promise.resolve('') }));

		capturedListener = null;
		const ggMock = {
			addLogListener(cb: (entry: CapturedEntry) => void) {
				capturedListener = cb;
			},
			removeLogListener(_cb: (entry: CapturedEntry) => void) {
				capturedListener = null;
			}
		};

		const { createGgPlugin } = await import('./plugin.js');
		$el = makeMockEl();
		plugin = createGgPlugin({}, ggMock);
		plugin.init($el as never);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	// -------------------------------------------------------------------------
	// Helper: send an entry through the captured listener
	// -------------------------------------------------------------------------
	function send(entry: CapturedEntry) {
		if (!capturedListener) throw new Error('listener not registered');
		capturedListener(entry);
	}

	// -------------------------------------------------------------------------
	// Basic tracking
	// -------------------------------------------------------------------------

	it('starts with an empty dropped-namespace map', () => {
		expect(plugin.getDroppedNamespaces().size).toBe(0);
	});

	it('does not track entries that pass the keep gate', () => {
		// Default keepPattern is '*' — everything passes
		send(makeEntry('routes/+page.svelte@handleClick'));
		expect(plugin.getDroppedNamespaces().size).toBe(0);
	});

	it('tracks a dropped entry when namespace does not match gg-keep', () => {
		storage.set('gg-keep', 'api:*');
		// Re-init so keepPattern is loaded
		plugin.init($el as never);

		const entry = makeEntry('routes/+page.svelte@handleClick', { timestamp: 1000 });
		send(entry);

		const dropped = plugin.getDroppedNamespaces();
		expect(dropped.size).toBe(1);

		const info = dropped.get('routes/+page.svelte@handleClick')!;
		expect(info.namespace).toBe('routes/+page.svelte@handleClick');
		expect(info.total).toBe(1);
		expect(info.firstSeen).toBe(1000);
		expect(info.lastSeen).toBe(1000);
		expect(info.preview).toBe(entry);
	});

	it('uses "log" as byType key for entries without a level', () => {
		storage.set('gg-keep', 'api:*');
		plugin.init($el as never);

		send(makeEntry('noise', { level: undefined }));

		const info = plugin.getDroppedNamespaces().get('noise')!;
		expect(info.byType).toEqual({ log: 1 });
	});

	it('uses the entry level as byType key for levelled entries', () => {
		storage.set('gg-keep', 'api:*');
		plugin.init($el as never);

		send(makeEntry('noise', { level: 'warn' }));
		send(makeEntry('noise', { level: 'error' }));
		send(makeEntry('noise', { level: 'warn' }));

		const info = plugin.getDroppedNamespaces().get('noise')!;
		expect(info.byType).toEqual({ warn: 2, error: 1 });
	});

	// -------------------------------------------------------------------------
	// Accumulation across multiple drops for the same namespace
	// -------------------------------------------------------------------------

	it('accumulates total count and updates lastSeen + preview on repeated drops', () => {
		storage.set('gg-keep', 'api:*');
		plugin.init($el as never);

		const e1 = makeEntry('noise', { timestamp: 1000 });
		const e2 = makeEntry('noise', { timestamp: 2000 });
		const e3 = makeEntry('noise', { timestamp: 3000 });

		send(e1);
		send(e2);
		send(e3);

		const info = plugin.getDroppedNamespaces().get('noise')!;
		expect(info.total).toBe(3);
		expect(info.firstSeen).toBe(1000);
		expect(info.lastSeen).toBe(3000);
		expect(info.preview).toBe(e3); // most recent
	});

	it('tracks distinct namespaces independently', () => {
		storage.set('gg-keep', 'api:*');
		plugin.init($el as never);

		send(makeEntry('noise/a'));
		send(makeEntry('noise/b'));
		send(makeEntry('noise/a'));

		const dropped = plugin.getDroppedNamespaces();
		expect(dropped.size).toBe(2);
		expect(dropped.get('noise/a')!.total).toBe(2);
		expect(dropped.get('noise/b')!.total).toBe(1);
	});

	it('does not count kept namespaces even when some namespaces are dropped', () => {
		storage.set('gg-keep', 'api:*');
		plugin.init($el as never);

		send(makeEntry('api:users')); // kept
		send(makeEntry('routes/+page.svelte')); // dropped

		const dropped = plugin.getDroppedNamespaces();
		expect(dropped.size).toBe(1);
		expect(dropped.has('api:users')).toBe(false);
		expect(dropped.has('routes/+page.svelte')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Clear paths
	// -------------------------------------------------------------------------

	it('clears droppedNamespaces when the clear button is clicked', () => {
		storage.set('gg-keep', 'api:*');
		plugin.init($el as never);

		send(makeEntry('noise'));
		expect(plugin.getDroppedNamespaces().size).toBe(1);

		// Simulate user clicking the Clear button
		$el.click('.gg-clear-btn');

		expect(plugin.getDroppedNamespaces().size).toBe(0);
	});

	it('clears droppedNamespaces when destroy() is called', () => {
		storage.set('gg-keep', 'api:*');
		plugin.init($el as never);

		send(makeEntry('noise'));
		expect(plugin.getDroppedNamespaces().size).toBe(1);

		plugin.destroy();

		expect(plugin.getDroppedNamespaces().size).toBe(0);
	});

	it('repopulates dropped map after a clear when new entries arrive', () => {
		storage.set('gg-keep', 'api:*');
		plugin.init($el as never);

		send(makeEntry('noise', { timestamp: 1000 }));
		$el.click('.gg-clear-btn');
		expect(plugin.getDroppedNamespaces().size).toBe(0);

		// New drop after clear
		send(makeEntry('noise', { timestamp: 2000 }));
		const info = plugin.getDroppedNamespaces().get('noise')!;
		expect(info.total).toBe(1);
		expect(info.firstSeen).toBe(2000);
	});

	// -------------------------------------------------------------------------
	// Mixed byType accumulation
	// -------------------------------------------------------------------------

	it('accumulates mixed byType counts across multiple levels for the same namespace', () => {
		storage.set('gg-keep', 'api:*');
		plugin.init($el as never);

		send(makeEntry('noise', { level: undefined })); // 'log'
		send(makeEntry('noise', { level: undefined })); // 'log'
		send(makeEntry('noise', { level: 'warn' }));
		send(makeEntry('noise', { level: 'error' }));

		const info = plugin.getDroppedNamespaces().get('noise')!;
		expect(info.byType).toEqual({ log: 2, warn: 1, error: 1 });
		expect(info.total).toBe(4);
	});
});
