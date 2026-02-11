/**
 * Tests for the core debug implementation (common.ts).
 *
 * Ported from debug's upstream test.js + new tests for humanize,
 * namespace matching, color determinism, and format replacement.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setup, humanize, type DebugFactory, type DebugEnv } from './common.js';

/** Create a debug factory with a minimal mock env (no colors, no persistence). */
function createFactory(overrides: Partial<DebugEnv> = {}): DebugFactory {
	const env: DebugEnv = {
		formatArgs() {},
		save() {},
		load: () => '',
		useColors: () => false,
		colors: ['#c0ffee', '#decade', '#bada55'],
		log() {},
		...overrides
	};
	return setup(env);
}

// ── humanize ───────────────────────────────────────────────────────────

describe('humanize', () => {
	it('formats milliseconds', () => {
		expect(humanize(0)).toBe('0ms');
		expect(humanize(1)).toBe('1ms');
		expect(humanize(999)).toBe('999ms');
	});

	it('formats seconds', () => {
		expect(humanize(1_000)).toBe('1s');
		expect(humanize(5_500)).toBe('6s');
		expect(humanize(59_999)).toBe('60s');
	});

	it('formats minutes', () => {
		expect(humanize(60_000)).toBe('1m');
		expect(humanize(120_000)).toBe('2m');
	});

	it('formats hours', () => {
		expect(humanize(3_600_000)).toBe('1h');
		expect(humanize(7_200_000)).toBe('2h');
	});

	it('formats days', () => {
		expect(humanize(86_400_000)).toBe('1d');
		expect(humanize(172_800_000)).toBe('2d');
	});

	it('handles negative values', () => {
		expect(humanize(-500)).toBe('-500ms');
		expect(humanize(-5_000)).toBe('-5s');
		expect(humanize(-120_000)).toBe('-2m');
	});
});

// ── Upstream test.js ports ─────────────────────────────────────────────

describe('debug (upstream ports)', () => {
	let debug: DebugFactory;

	beforeEach(() => {
		debug = createFactory();
	});

	it('passes a basic sanity check', () => {
		const log = debug('test');
		log.enabled = true;
		log.log = () => {};

		expect(() => log('hello world')).not.toThrow();
	});

	it('allows namespaces to be a non-string value', () => {
		const log = debug('test');
		log.enabled = true;
		log.log = () => {};

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(() => debug.enable(true as any)).not.toThrow();
	});

	it('honors global debug namespace enable calls', () => {
		expect(debug('test:12345').enabled).toBe(false);
		expect(debug('test:67890').enabled).toBe(false);

		debug.enable('test:12345');
		expect(debug('test:12345').enabled).toBe(true);
		expect(debug('test:67890').enabled).toBe(false);
	});

	it('uses custom log function', () => {
		const log = debug('test');
		log.enabled = true;

		const messages: unknown[][] = [];
		log.log = (...args: unknown[]) => messages.push(args);

		log('using custom log function');
		log('using custom log function again');
		log('%O', 12345);

		expect(messages.length).toBe(3);
	});

	describe('rebuild namespaces string (disable)', () => {
		it('handles names, skips, and wildcards', () => {
			debug.enable('test,abc*,-abc');
			const namespaces = debug.disable();
			expect(namespaces).toBe('test,abc*,-abc');
		});

		it('handles empty', () => {
			debug.enable('');
			const namespaces = debug.disable();
			expect(namespaces).toBe('');
			expect(debug.names).toEqual([]);
			expect(debug.skips).toEqual([]);
		});

		it('handles all', () => {
			debug.enable('*');
			const namespaces = debug.disable();
			expect(namespaces).toBe('*');
		});

		it('handles skip all', () => {
			debug.enable('-*');
			const namespaces = debug.disable();
			expect(namespaces).toBe('-*');
		});

		it('names+skips same with new string', () => {
			debug.enable('test,abc*,-abc');
			const oldNames = [...debug.names];
			const oldSkips = [...debug.skips];
			const namespaces = debug.disable();
			expect(namespaces).toBe('test,abc*,-abc');
			debug.enable(namespaces);
			expect(debug.names.map(String)).toEqual(oldNames.map(String));
			expect(debug.skips.map(String)).toEqual(oldSkips.map(String));
		});

		it('handles re-enabling existing instances', () => {
			debug.enable('');
			const inst = debug('foo');
			const messages: string[] = [];
			inst.log = (...args: unknown[]) => messages.push(String(args[0]));

			inst('test1');
			expect(messages).toEqual([]);

			debug.enable('foo');
			// Old call already happened, shouldn't retroactively appear
			expect(messages).toEqual([]);

			inst('test2');
			expect(messages.length).toBe(1);

			inst('test3');
			expect(messages.length).toBe(2);

			debug.enable('');
			inst('test4');
			expect(messages.length).toBe(2);
		});
	});
});

// ── Namespace matching ─────────────────────────────────────────────────

describe('namespace matching', () => {
	let debug: DebugFactory;

	beforeEach(() => {
		debug = createFactory();
	});

	it('matches exact namespace', () => {
		debug.enable('foo');
		expect(debug.enabled('foo')).toBe(true);
		expect(debug.enabled('bar')).toBe(false);
	});

	it('matches wildcard *', () => {
		debug.enable('*');
		expect(debug.enabled('foo')).toBe(true);
		expect(debug.enabled('bar')).toBe(true);
		expect(debug.enabled('foo:bar')).toBe(true);
	});

	it('matches partial wildcard', () => {
		debug.enable('foo*');
		expect(debug.enabled('foo')).toBe(true);
		expect(debug.enabled('foobar')).toBe(true);
		expect(debug.enabled('foo:bar')).toBe(true);
		expect(debug.enabled('bar')).toBe(false);
	});

	it('matches colon-separated wildcard', () => {
		debug.enable('foo:*');
		expect(debug.enabled('foo:bar')).toBe(true);
		expect(debug.enabled('foo:baz')).toBe(true);
		expect(debug.enabled('foo')).toBe(false);
	});

	it('skips take priority over includes', () => {
		debug.enable('foo*,-foo:bar');
		expect(debug.enabled('foo')).toBe(true);
		expect(debug.enabled('foo:baz')).toBe(true);
		expect(debug.enabled('foo:bar')).toBe(false);
	});

	it('handles multiple includes', () => {
		debug.enable('foo,bar,baz');
		expect(debug.enabled('foo')).toBe(true);
		expect(debug.enabled('bar')).toBe(true);
		expect(debug.enabled('baz')).toBe(true);
		expect(debug.enabled('qux')).toBe(false);
	});

	it('handles whitespace as separator', () => {
		debug.enable('foo bar baz');
		expect(debug.enabled('foo')).toBe(true);
		expect(debug.enabled('bar')).toBe(true);
		expect(debug.enabled('baz')).toBe(true);
	});

	it('handles skip-all', () => {
		debug.enable('-*');
		expect(debug.enabled('foo')).toBe(false);
		expect(debug.enabled('bar')).toBe(false);
	});

	it('skip-all plus explicit include: skip wins', () => {
		debug.enable('foo,-*');
		expect(debug.enabled('foo')).toBe(false);
	});
});

// ── Color determinism ──────────────────────────────────────────────────

describe('selectColor', () => {
	it('same namespace always gets same color', () => {
		const debug = createFactory();
		const a = debug('myapp');
		const b = debug('myapp');
		expect(a.color).toBe(b.color);
	});

	it('different namespaces may get different colors', () => {
		const debug = createFactory();
		// With only 3 colors in our mock, collisions are possible,
		// but "foo" and "bar" should hash differently
		const a = debug('foo');
		const b = debug('bar');
		// We just verify they're valid colors from our palette
		expect(['#c0ffee', '#decade', '#bada55']).toContain(a.color);
		expect(['#c0ffee', '#decade', '#bada55']).toContain(b.color);
	});
});

// ── Format replacement ─────────────────────────────────────────────────

describe('format replacement', () => {
	let debug: DebugFactory;

	beforeEach(() => {
		debug = createFactory();
	});

	it('replaces %% with literal %', () => {
		const log = debug('test');
		log.enabled = true;

		const captured: unknown[][] = [];
		log.log = (...args: unknown[]) => captured.push(args);

		log('100%% done');
		expect(captured.length).toBe(1);
		expect(captured[0][0]).toContain('100% done');
	});

	it('unknown formatters pass through', () => {
		const log = debug('test');
		log.enabled = true;

		const captured: unknown[][] = [];
		log.log = (...args: unknown[]) => captured.push(args);

		log('hello %s world', 'test');
		expect(captured.length).toBe(1);
		// %s is not registered in our mock env, so it passes through
		expect(captured[0][0]).toContain('%s');
		// The extra arg remains
		expect(captured[0][1]).toBe('test');
	});

	it('custom formatter replaces correctly', () => {
		debug.formatters.x = (val: unknown) => `[${val}]`;

		const log = debug('test');
		log.enabled = true;

		const captured: unknown[][] = [];
		log.log = (...args: unknown[]) => captured.push(args);

		log('value: %x end', 42);
		expect(captured.length).toBe(1);
		expect(captured[0][0]).toContain('[42]');
		// The replaced arg should be spliced out
		expect(captured[0].length).toBe(1);
	});

	it('non-string first arg gets %O prepended', () => {
		const log = debug('test');
		log.enabled = true;

		const captured: unknown[][] = [];
		log.log = (...args: unknown[]) => captured.push(args);

		log({ key: 'value' });
		expect(captured.length).toBe(1);
		// First arg should now be the format string with %O
		// Second arg should be the object (unless %O formatter consumed it)
	});
});

// ── enabled setter override ────────────────────────────────────────────

describe('enabled setter override', () => {
	it('can force-enable a disabled namespace', () => {
		const debug = createFactory();
		debug.enable('');
		const log = debug('test');
		expect(log.enabled).toBe(false);

		log.enabled = true;
		expect(log.enabled).toBe(true);
	});

	it('can force-disable an enabled namespace', () => {
		const debug = createFactory();
		debug.enable('test');
		const log = debug('test');
		expect(log.enabled).toBe(true);

		log.enabled = false;
		expect(log.enabled).toBe(false);
	});
});

// ── factory.namespaces property ────────────────────────────────────────

describe('factory.namespaces', () => {
	it('reflects current enabled namespaces', () => {
		const debug = createFactory();
		expect(debug.namespaces).toBe('');

		debug.enable('foo,bar,-baz');
		expect(debug.namespaces).toBe('foo,bar,-baz');

		debug.disable();
		expect(debug.namespaces).toBe('');
	});
});
