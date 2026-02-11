import { describe, it, expect } from 'vitest';
import { transformGgCalls } from './gg-call-sites-plugin.js';

/** Find script ranges (same logic as plugin's findScriptRanges) */
function findScriptRanges(code: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	const openRegex = /<script\b[^>]*>/gi;
	let match;
	while ((match = openRegex.exec(code)) !== null) {
		const contentStart = match.index + match[0].length;
		const closeIdx = code.indexOf('</script>', contentStart);
		if (closeIdx !== -1) {
			ranges.push({ start: contentStart, end: closeIdx });
		}
	}
	return ranges;
}

describe('gg() in svelte template markup (currently skipped)', () => {
	it('transforms gg() only in <script>, skips template', () => {
		const code = `<script>
function handleClick() {
    gg('from script');
}
</script>

<button onclick={() => gg('from template')}>Click</button>`;

		const scriptRanges = findScriptRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', scriptRanges);

		expect(result).not.toBeNull();
		const out = result!.code;

		// Script: transformed with object literal syntax
		expect(out).toContain("gg._ns({ns:'test.svelte@handleClick'");

		// Template: left untouched (skipped until AST-based detection)
		expect(out).toContain("onclick={() => gg('from template')");
	});

	it('skips gg.ns() in template', () => {
		const code = `<script>
let x = 1;
</script>

<button onclick={() => gg.ns('ERROR', 'bad')}>Click</button>`;

		const scriptRanges = findScriptRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', scriptRanges);

		// Only script has gg calls, and there are none there
		// So the template gg.ns is untouched → no modification
		expect(result).toBeNull();
	});

	it('skips gg() in template expressions', () => {
		const code = `<script>let x;</script>
<div>{gg()}</div>`;

		const scriptRanges = findScriptRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', scriptRanges);

		// No gg() in script → null (no transform)
		expect(result).toBeNull();
	});

	it('leaves prose text gg() untouched', () => {
		const code = `<script>let x;</script>
<p>Some text mentioning gg() in prose</p>`;

		const scriptRanges = findScriptRanges(code);
		const result = transformGgCalls(code, 'test.svelte', 'src/test.svelte', scriptRanges);

		// No gg() in script → null (no transform)
		expect(result).toBeNull();
	});

	it('does not use gg._o() in non-svelte files', () => {
		// No scriptRanges → all calls use object literal syntax
		const code = 'function test() { gg("hello") }';
		const result = transformGgCalls(code, 'test.ts', 'src/test.ts');

		expect(result).not.toBeNull();
		const out = result!.code;

		expect(out).toContain("gg._ns({ns:'test.ts@test'");
		expect(out).not.toContain('gg._o(');
	});
});
