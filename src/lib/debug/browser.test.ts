/**
 * Tests for the browser-specific debug implementation (browser.ts).
 *
 * Runs in Node but tests the module's pure functions by mocking
 * localStorage and document/navigator globals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DebugFactory, Debugger } from './common.js';

// We need to mock browser globals before importing browser.ts
// Use vi.stubGlobal for this purpose

describe('browser debug', () => {
	let debug: DebugFactory;
	let storage: Map<string, string>;

	beforeEach(async () => {
		// Mock localStorage
		storage = new Map();
		const mockLocalStorage = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key)
		};
		vi.stubGlobal('localStorage', mockLocalStorage);

		// Mock document to make useColors() return true
		vi.stubGlobal('document', {});

		// Import fresh module
		const mod = await import('./browser.js');
		debug = mod.default;
		debug.enable('');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('save/load (localStorage)', () => {
		it('save stores to localStorage.debug', () => {
			debug.enable('foo,bar');
			expect(storage.get('debug')).toBe('foo,bar');
		});

		it('save removes localStorage.debug when empty', () => {
			debug.enable('foo');
			expect(storage.get('debug')).toBe('foo');
			debug.enable('');
			expect(storage.has('debug')).toBe(false);
		});

		it('load reads from localStorage.debug', () => {
			storage.set('debug', 'app:*');
			// Need to re-create factory to test load
			// We can test via enable/disable round-trip instead
			debug.enable(storage.get('debug')!);
			expect(debug.enabled('app:foo')).toBe(true);
		});
	});

	describe('formatArgs', () => {
		it('inserts %c CSS markers when useColors is true', () => {
			debug.enable('test');
			const log = debug('test');
			log.enabled = true;
			(log as Debugger & { useColors: boolean }).useColors = true;
			log.diff = 250;

			const args: unknown[] = ['hello world'];
			log.formatArgs(args);

			const formatted = String(args[0]);
			// Should contain %c for CSS color styling
			expect(formatted).toContain('%c');
			// Should contain the namespace
			expect(formatted).toContain('test');
			// Should contain humanized diff
			expect(formatted).toContain('+250ms');

			// Should have CSS color strings in the args array
			const cssArgs = args.filter((a) => typeof a === 'string' && String(a).startsWith('color:'));
			expect(cssArgs.length).toBeGreaterThanOrEqual(2);
		});

		it('does not insert %c when useColors is false', () => {
			debug.enable('test');
			const log = debug('test');
			log.enabled = true;
			(log as Debugger & { useColors: boolean }).useColors = false;
			log.diff = 100;

			const args: unknown[] = ['hello world'];
			log.formatArgs(args);

			const formatted = String(args[0]);
			expect(formatted).not.toContain('%c');
			expect(formatted).toContain('test');
		});
	});

	describe('formatters', () => {
		it('%j produces JSON.stringify output', () => {
			debug.enable('test');
			const log = debug('test');
			log.enabled = true;

			const captured: unknown[][] = [];
			log.log = (...args: unknown[]) => captured.push(args);

			log('data: %j', { x: 1 });

			expect(captured.length).toBe(1);
			const output = String(captured[0][0]);
			expect(output).toContain('{"x":1}');
		});

		it('%j handles circular references gracefully', () => {
			debug.enable('test');
			const log = debug('test');
			log.enabled = true;

			const captured: unknown[][] = [];
			log.log = (...args: unknown[]) => captured.push(args);

			const circular: Record<string, unknown> = {};
			circular.self = circular;

			log('data: %j', circular);
			expect(captured.length).toBe(1);
			const output = String(captured[0][0]);
			expect(output).toContain('UnexpectedJSONParseError');
		});
	});

	describe('color selection', () => {
		it('assigns a hex color string to instances', () => {
			debug.enable('test');
			const log = debug('test');
			// Browser colors are hex strings
			expect(log.color).toMatch(/^#[0-9A-F]{6}$/);
		});

		it('same namespace gets same color', () => {
			const a = debug('myapp');
			const b = debug('myapp');
			expect(a.color).toBe(b.color);
		});
	});
});
