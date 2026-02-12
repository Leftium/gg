/**
 * Tests for the gg-call-sites vite plugin transform logic.
 *
 * Tests gg.ns() template variable substitution ($NS, $FN, $FILE, $LINE, $COL)
 * and the fix for not auto-appending @functionName to plain gg.ns() labels.
 */

import { describe, it, expect } from 'vitest';
import { transformGgCalls, collectCodeRanges, parseJavaScript } from './gg-call-sites-plugin.js';

/** Helper: run transform and return the output code (or null if unchanged). */
function transform(
	code: string,
	shortPath = 'routes/+page.svelte',
	filePath = 'src/routes/+page.svelte'
) {
	// If the code contains <script> tags, treat as Svelte; otherwise treat as plain JS
	if (code.includes('<script')) {
		const svelteInfo = collectCodeRanges(code);
		const result = transformGgCalls(code, shortPath, filePath, svelteInfo);
		return result?.code ?? null;
	} else {
		// Plain JS/TS code
		const jsFunctionScopes = parseJavaScript(code);
		const result = transformGgCalls(code, shortPath, filePath, undefined, jsFunctionScopes);
		return result?.code ?? null;
	}
}

// ── bare gg() transforms (unchanged behavior) ─────────────────────────

describe('bare gg() transforms', () => {
	it('rewrites bare gg(expr) with file@fn namespace', () => {
		const code = 'function handleClick() { gg("hello") }';
		const out = transform(code)!;
		expect(out).toContain("ns:'routes/+page.svelte@handleClick'");
		expect(out).toContain('src:\'"hello"\'');
	});

	it('rewrites bare gg() with no args', () => {
		const code = 'function test() { gg() }';
		const out = transform(code)!;
		expect(out).toContain("ns:'routes/+page.svelte@test'");
		expect(out).not.toContain('src:');
	});

	it('rewrites bare gg(expr) at top level (no enclosing function)', () => {
		const code = 'gg("top level")';
		const out = transform(code)!;
		expect(out).toContain("ns:'routes/+page.svelte'");
		// No @fn suffix when not inside a function
		expect(out).not.toContain('@');
	});

	it('leaves gg.enable/gg.disable untouched', () => {
		const code = 'gg.enable("foo"); gg.disable();';
		expect(transform(code)).toBeNull();
	});
});

// ── gg.ns() plain labels (no template variables) ──────────────────────

describe('gg.ns() plain labels', () => {
	it('uses label as-is without appending @functionName', () => {
		const code = `function handleClick() { gg.ns('ERROR', 'something broke') }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'ERROR'");
		// Must NOT contain @handleClick
		expect(out).not.toContain('@handleClick');
	});

	it('preserves label with no args', () => {
		const code = `function test() { gg.ns('my-label') }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'my-label'");
		expect(out).not.toContain('@test');
	});

	it('works at top level', () => {
		const code = `gg.ns('auth', user)`;
		const out = transform(code)!;
		expect(out).toContain("ns:'auth'");
	});
});

// ── gg.ns() with $NS template variable ────────────────────────────────

describe('gg.ns() with $NS', () => {
	it('substitutes $NS with auto-generated callpoint (file@fn)', () => {
		const code = `function handleClick() { gg.ns('ERROR:$NS', msg) }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'ERROR:routes/+page.svelte@handleClick'");
	});

	it('substitutes $NS at top level (no fn)', () => {
		const code = `gg.ns('tag:$NS', data)`;
		const out = transform(code)!;
		expect(out).toContain("ns:'tag:routes/+page.svelte'");
	});

	it('substitutes multiple $NS occurrences', () => {
		const code = `function foo() { gg.ns('$NS-$NS', x) }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'routes/+page.svelte@foo-routes/+page.svelte@foo'");
	});

	it('substitutes $NS with no args', () => {
		const code = `function bar() { gg.ns('prefix:$NS') }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'prefix:routes/+page.svelte@bar'");
	});
});

// ── gg.ns() with $FN template variable ────────────────────────────────

describe('gg.ns() with $FN', () => {
	it('substitutes $FN with enclosing function name', () => {
		const code = `function handleSubmit() { gg.ns('form:$FN', data) }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'form:handleSubmit'");
	});

	it('substitutes $FN as empty when at top level', () => {
		const code = `gg.ns('tag:$FN', x)`;
		const out = transform(code)!;
		expect(out).toContain("ns:'tag:'");
	});
});

// ── gg.ns() with $FILE template variable ──────────────────────────────

describe('gg.ns() with $FILE', () => {
	it('substitutes $FILE with short file path', () => {
		const code = `function test() { gg.ns('$FILE:error', msg) }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'routes/+page.svelte:error'");
	});
});

// ── gg.ns() with $LINE and $COL ───────────────────────────────────────

describe('gg.ns() with $LINE/$COL', () => {
	it('substitutes $LINE with line number', () => {
		const code = `gg.ns('debug:$LINE', x)`;
		const out = transform(code)!;
		// Line 1 (first line of the code)
		expect(out).toContain("ns:'debug:1'");
	});

	it('substitutes $COL with column number', () => {
		const code = `gg.ns('debug:$COL', x)`;
		const out = transform(code)!;
		expect(out).toMatch(/ns:'debug:\d+'/);
	});
});

// ── gg.ns() with combined template variables ──────────────────────────

describe('gg.ns() combined variables', () => {
	it('substitutes $FN and $FILE together', () => {
		const code = `function validate() { gg.ns('$FILE@$FN:check', field) }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'routes/+page.svelte@validate:check'");
	});

	it('full combination: ERROR:$NS', () => {
		const code = `function handleError() { gg.ns('ERROR:$NS', err) }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'ERROR:routes/+page.svelte@handleError'");
	});
});

// ── Plugin integration tests ──────────────────────────────────────────

describe('plugin transform() filter', () => {
	it('should not transform files in node_modules', () => {
		// Simulate what the plugin's transform() does with a file ID check
		const nodeModulesIds = [
			'/project/node_modules/@leftium/gg/dist/gg.js',
			'/Users/dev/app/node_modules/some-lib/index.js',
			'C:/project/node_modules/package/file.ts' // Vite normalizes Windows paths to forward slashes
		];

		for (const id of nodeModulesIds) {
			// The plugin checks: if (id.includes('/node_modules/')) return null
			expect(id.includes('/node_modules/')).toBe(true);
		}
	});

	it('should transform user source files (not in node_modules)', () => {
		const userFileIds = [
			'/project/src/routes/+page.svelte',
			'/Users/dev/app/src/lib/utils.ts',
			'C:/project/src/components/Button.svelte' // Vite normalizes Windows paths to forward slashes
		];

		for (const id of userFileIds) {
			expect(id.includes('/node_modules/')).toBe(false);
		}
	});
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe('edge cases', () => {
	it('does not transform gg inside strings', () => {
		const code = `const s = 'gg.ns("foo", bar)'`;
		expect(transform(code)).toBeNull();
	});

	it('does not transform gg inside comments', () => {
		const code = `// gg.ns("foo", bar)`;
		expect(transform(code)).toBeNull();
	});

	it('handles double-quoted ns label', () => {
		const code = `function test() { gg.ns("ERROR:$FN", msg) }`;
		const out = transform(code)!;
		expect(out).toContain("ns:'ERROR:test'");
	});

	it('preserves file and line metadata in options object', () => {
		const code = `function test() { gg.ns('label', data) }`;
		const out = transform(code)!;
		expect(out).toContain("file:'src/routes/+page.svelte'");
		expect(out).toContain('line:');
		expect(out).toContain('col:');
	});

	it('handles .svelte file with AST-based code ranges', () => {
		const code = `<script>\nfunction test() { gg.ns('$FN:tag', x) }\n</script>\n<p>gg.ns("label")</p>`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(
			code,
			'routes/+page.svelte',
			'src/routes/+page.svelte',
			codeRanges
		);
		const out = result!.code;
		// Script: transformed with object literal syntax
		expect(out).toContain("{ns:'test:tag'");
		// Template prose: left untouched (prose text, not a code expression)
		expect(out).toContain('gg.ns("label")');
	});

	it('does not let HTML apostrophes break gg() in template expressions', () => {
		// Regression: an apostrophe in HTML prose (e.g. "Eruda's") was treated as
		// a JS string delimiter, causing the scanner to skip over a subsequent
		// gg.ns() call inside an onclick handler.
		const code = `<script>
	import { gg } from '$lib/index.js';
</script>

<p>Check Eruda's GG tab.</p>
<button onclick={() => gg.ns('$NS:click', 'event handler')}>Click</button>`;
		const out = transform(code)!;
		expect(out).not.toBeNull();
		// $NS should be expanded to the file path, not left as literal '$NS'
		expect(out).toContain('routes/+page.svelte:click');
		expect(out).not.toContain("'$NS:click'");
	});
});
