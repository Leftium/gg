/**
 * Tests for Svelte template gg() transforms using svelte.parse() AST.
 *
 * The plugin now uses svelte.parse() to distinguish real JS expressions
 * ({gg()}, onclick={() => gg()}, etc.) from prose text mentioning gg().
 * Template expressions are transformed using gg._o() syntax (no braces).
 */

import { describe, it, expect } from 'vitest';
import { transformGgCalls, collectCodeRanges } from './gg-call-sites-plugin.js';

describe('collectCodeRanges()', () => {
	it('returns script ranges for <script> blocks', () => {
		const code = `<script>let x = 1;</script>`;
		const ranges = collectCodeRanges(code);
		const scripts = ranges.filter((r) => r.context === 'script');
		expect(scripts.length).toBe(1);
		expect(code.slice(scripts[0].start, scripts[0].end)).toContain('let x = 1;');
	});

	it('returns both instance and module script ranges', () => {
		const code = `<script>let x = 1;</script>\n<script module>const y = 2;</script>`;
		const ranges = collectCodeRanges(code);
		const scripts = ranges.filter((r) => r.context === 'script');
		expect(scripts.length).toBe(2);
	});

	it('returns template ranges for {expr} tags', () => {
		const code = `<script>let x;</script>\n<div>{x + 1}</div>`;
		const ranges = collectCodeRanges(code);
		const templates = ranges.filter((r) => r.context === 'template');
		expect(templates.length).toBeGreaterThanOrEqual(1);
	});

	it('returns template ranges for event handler attributes', () => {
		const code = `<script>let fn;</script>\n<button onclick={fn}>click</button>`;
		const ranges = collectCodeRanges(code);
		const templates = ranges.filter((r) => r.context === 'template');
		expect(templates.length).toBeGreaterThanOrEqual(1);
	});

	it('does NOT include prose text as a code range', () => {
		const code = `<script>let x;</script>\n<p>some text gg() in prose</p>`;
		const ranges = collectCodeRanges(code);
		// The text "gg()" in prose should not be in any range
		const ggPos = code.indexOf('gg()');
		const inRange = ranges.some((r) => ggPos >= r.start && ggPos < r.end);
		expect(inRange).toBe(false);
	});

	it('returns template ranges for {#if expr}', () => {
		const code = `<script>let cond;</script>\n{#if cond}yes{/if}`;
		const ranges = collectCodeRanges(code);
		const templates = ranges.filter((r) => r.context === 'template');
		expect(templates.length).toBeGreaterThanOrEqual(1);
	});

	it('returns template ranges for bind: directives', () => {
		const code = `<script>let val;</script>\n<input bind:value={val} />`;
		const ranges = collectCodeRanges(code);
		const templates = ranges.filter((r) => r.context === 'template');
		expect(templates.length).toBeGreaterThanOrEqual(1);
	});

	it('returns template ranges for class: directives', () => {
		const code = `<script>let active;</script>\n<div class:active={active}>x</div>`;
		const ranges = collectCodeRanges(code);
		const templates = ranges.filter((r) => r.context === 'template');
		expect(templates.length).toBeGreaterThanOrEqual(1);
	});
});

describe('gg() in svelte template markup (AST-based)', () => {
	it('transforms gg() in <script> with object literal syntax', () => {
		const code = `<script>\nfunction handleClick() {\n    gg('from script');\n}\n</script>\n\n<p>text</p>`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', codeRanges);

		expect(result).not.toBeNull();
		const out = result!.code;
		expect(out).toContain("gg._ns({ns:'test.svelte@handleClick'");
	});

	it('transforms gg() in {expr} with gg._o() syntax', () => {
		const code = `<script>let x;</script>\n<div>{gg('hello')}</div>`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', codeRanges);

		expect(result).not.toBeNull();
		const out = result!.code;
		// Template: uses gg._o() (no braces)
		expect(out).toContain('gg._o(');
		expect(out).toContain('gg._ns(');
	});

	it('transforms gg() in onclick handler with gg._o() syntax', () => {
		const code = `<script>let x;</script>\n<button onclick={() => gg('click')}>btn</button>`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', codeRanges);

		expect(result).not.toBeNull();
		const out = result!.code;
		expect(out).toContain('gg._o(');
		expect(out).toContain('gg._ns(');
	});

	it('transforms gg.ns() in template with gg._o() syntax', () => {
		const code = `<script>let x;</script>\n<button onclick={() => gg.ns('ERROR', 'bad')}>btn</button>`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', codeRanges);

		expect(result).not.toBeNull();
		const out = result!.code;
		expect(out).toContain('gg._o(');
		expect(out).toContain("'ERROR'");
	});

	it('leaves prose text gg() untouched', () => {
		const code = `<script>let x;</script>\n<p>Some text mentioning gg() in prose</p>`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', codeRanges);

		// No gg() in any code range → null (no transform)
		expect(result).toBeNull();
	});

	it('transforms script gg() but leaves prose gg() untouched', () => {
		const code = `<script>\nfunction test() {\n    gg('in script');\n}\n</script>\n\n<p>prose gg() text</p>`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', codeRanges);

		expect(result).not.toBeNull();
		const out = result!.code;
		// Script gg() transformed
		expect(out).toContain("gg._ns({ns:'test.svelte@test'");
		// Prose gg() untouched
		expect(out).toContain('prose gg() text');
	});

	it('transforms gg() in bare template expression {gg()}', () => {
		const code = `<script>let x;</script>\n{gg()}`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', codeRanges);

		expect(result).not.toBeNull();
		const out = result!.code;
		expect(out).toContain('gg._o(');
	});

	it('does not use gg._o() in non-svelte files', () => {
		// No codeRanges → all calls use object literal syntax
		const code = 'function test() { gg("hello") }';
		const result = transformGgCalls(code, 'test.ts', 'src/test.ts');

		expect(result).not.toBeNull();
		const out = result!.code;
		expect(out).toContain("gg._ns({ns:'test.ts@test'");
		expect(out).not.toContain('gg._o(');
	});

	it('transforms gg() inside {#each} expression', () => {
		const code = `<script>let items;</script>\n{#each gg(items) as item}{item}{/each}`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', codeRanges);

		expect(result).not.toBeNull();
		const out = result!.code;
		// The gg(items) in the each expression should be transformed
		expect(out).toContain('gg._ns(');
	});

	it('transforms gg.ns() with $NS in template', () => {
		const code = `<script>let x;</script>\n<button onclick={() => gg.ns('$NS:click', x)}>btn</button>`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', codeRanges);

		expect(result).not.toBeNull();
		const out = result!.code;
		expect(out).toContain('gg._o(');
		expect(out).toContain('test.svelte');
	});
});
