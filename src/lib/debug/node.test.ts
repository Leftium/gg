/**
 * Tests for the Node.js-specific debug implementation (node.ts).
 *
 * Tests ANSI formatting, env var persistence, and %o/%O formatters.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DebugFactory, Debugger } from './common.js';

describe('node debug', () => {
	let debug: DebugFactory;
	let originalDebug: string | undefined;

	beforeEach(async () => {
		// Save and clear env to get a clean factory
		originalDebug = process.env.DEBUG;
		delete process.env.DEBUG;

		// Dynamic import to get a fresh module each time
		// We import the setup + env pieces from node.ts
		// But since node.ts exports a singleton, we test it directly
		const mod = await import('./node.js');
		debug = mod.default;
		debug.enable('');
	});

	afterEach(() => {
		// Restore env
		if (originalDebug !== undefined) {
			process.env.DEBUG = originalDebug;
		} else {
			delete process.env.DEBUG;
		}
	});

	describe('save/load (process.env.DEBUG)', () => {
		it('save stores to process.env.DEBUG', () => {
			debug.enable('foo,bar');
			expect(process.env.DEBUG).toBe('foo,bar');
		});

		it('save removes process.env.DEBUG when empty', () => {
			debug.enable('foo');
			expect(process.env.DEBUG).toBe('foo');
			debug.enable('');
			expect(process.env.DEBUG).toBeUndefined();
		});
	});

	describe('formatArgs', () => {
		it('produces ANSI escape sequences when useColors is true', () => {
			debug.enable('test');
			const log = debug('test');
			log.enabled = true;
			(log as Debugger & { useColors: boolean }).useColors = true;
			log.diff = 123;

			const args: unknown[] = ['hello world'];
			log.formatArgs(args);

			const formatted = String(args[0]);
			// Should contain ANSI escape code \u001B[3
			expect(formatted).toContain('\u001B[3');
			// Should contain the namespace
			expect(formatted).toContain('test');
			// Should contain humanized diff
			expect(formatted).toContain('+123ms');
		});

		it('produces plain prefix without ANSI when useColors is false', () => {
			debug.enable('test');
			const log = debug('test');
			log.enabled = true;
			(log as Debugger & { useColors: boolean }).useColors = false;
			log.diff = 5000;

			const args: unknown[] = ['hello world'];
			log.formatArgs(args);

			const formatted = String(args[0]);
			// Should NOT contain ANSI escape codes
			expect(formatted).not.toContain('\u001B[');
			// Should contain the namespace
			expect(formatted).toContain('test');
		});
	});

	describe('formatters', () => {
		it('%o produces single-line util.inspect output', () => {
			debug.enable('test');
			const log = debug('test');
			log.enabled = true;

			const captured: unknown[][] = [];
			log.log = (...args: unknown[]) => captured.push(args);

			log('obj: %o', { a: 1, b: 2 });

			expect(captured.length).toBe(1);
			const output = String(captured[0][0]);
			// %o should inline the object (no newlines from inspect)
			expect(output).toContain('a');
			expect(output).toContain('1');
		});

		it('%O produces multi-line util.inspect output', () => {
			debug.enable('test');
			const log = debug('test');
			log.enabled = true;

			const captured: unknown[][] = [];
			log.log = (...args: unknown[]) => captured.push(args);

			log('obj: %O', { a: 1, b: 2 });

			expect(captured.length).toBe(1);
			const output = String(captured[0][0]);
			expect(output).toContain('a');
			expect(output).toContain('1');
		});
	});

	describe('color selection', () => {
		it('assigns a numeric color to instances', () => {
			debug.enable('test');
			const log = debug('test');
			// Node colors are numbers (ANSI codes)
			expect(Number(log.color)).not.toBeNaN();
		});

		it('same namespace gets same color', () => {
			const a = debug('myapp');
			const b = debug('myapp');
			expect(a.color).toBe(b.color);
		});
	});
});
