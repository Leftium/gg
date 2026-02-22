/**
 * Tests for the gg-call-sites vite plugin transform logic.
 *
 * The plugin rewrites:
 * - gg(expr) → gg._ns({ns, file, line, col, src}, expr)
 * - gg.here() → gg._here({ns, file, line, col})
 * - gg.time/timeLog/timeEnd → gg._time/_timeLog/_timeEnd with metadata
 *
 * Chain methods (.ns(), .warn(), .error(), etc.) are NOT rewritten by the
 * plugin — they run at runtime and resolve template variables from the
 * metadata baked into the gg._ns() options object.
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

// ── bare gg() transforms ───────────────────────────────────────────────

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

	it('preserves chain methods after gg() — plugin does not rewrite chains', () => {
		const code = `function test() { gg("hello").ns("custom").warn() }`;
		const out = transform(code)!;
		// Plugin rewrites gg("hello") but leaves .ns("custom").warn() untouched
		expect(out).toContain("gg._ns({ns:'routes/+page.svelte@test'");
		expect(out).toContain('.ns("custom").warn()');
	});

	it('preserves .v passthrough accessor', () => {
		const code = `function test() { const x = gg(value).v }`;
		const out = transform(code)!;
		expect(out).toContain('gg._ns(');
		expect(out).toContain('.v');
	});
});

// ── gg.here() transforms ──────────────────────────────────────────────

describe('gg.here() transforms', () => {
	it('rewrites gg.here() to gg._here() with metadata', () => {
		const code = 'function test() { gg.here() }';
		const out = transform(code)!;
		expect(out).toContain("gg._here({ns:'routes/+page.svelte@test'");
		expect(out).toContain("file:'src/routes/+page.svelte'");
	});

	it('rewrites gg.here() at top level', () => {
		const code = 'const info = gg.here()';
		const out = transform(code)!;
		expect(out).toContain("gg._here({ns:'routes/+page.svelte'");
	});
});

// ── gg.time/timeLog/timeEnd transforms ────────────────────────────────

describe('timer transforms', () => {
	it('rewrites gg.time() with metadata', () => {
		const code = `function test() { gg.time('fetch') }`;
		const out = transform(code)!;
		expect(out).toContain("gg._time({ns:'routes/+page.svelte@test'");
		expect(out).toContain("'fetch'");
	});

	it('rewrites gg.time() with no args', () => {
		const code = `function test() { gg.time() }`;
		const out = transform(code)!;
		expect(out).toContain("gg._time({ns:'routes/+page.svelte@test'");
	});

	it('rewrites gg.timeLog() with metadata', () => {
		const code = `function test() { gg.timeLog('fetch', 'step 1') }`;
		const out = transform(code)!;
		expect(out).toContain("gg._timeLog({ns:'routes/+page.svelte@test'");
	});

	it('rewrites gg.timeEnd() with metadata', () => {
		const code = `function test() { gg.timeEnd('fetch') }`;
		const out = transform(code)!;
		expect(out).toContain("gg._timeEnd({ns:'routes/+page.svelte@test'");
	});

	it('preserves .ns() chain after gg.time()', () => {
		const code = `function test() { gg.time('fetch').ns('api-pipeline') }`;
		const out = transform(code)!;
		// Plugin rewrites gg.time() but leaves .ns() chain untouched
		expect(out).toContain('gg._time(');
		expect(out).toContain(".ns('api-pipeline')");
	});
});

// ── Plugin integration tests ──────────────────────────────────────────

describe('plugin transform() filter', () => {
	it('should not transform files in node_modules', () => {
		const nodeModulesIds = [
			'/project/node_modules/@leftium/gg/dist/gg.js',
			'/Users/dev/app/node_modules/some-lib/index.js',
			'C:/project/node_modules/package/file.ts'
		];

		for (const id of nodeModulesIds) {
			expect(id.includes('/node_modules/')).toBe(true);
		}
	});

	it('should transform user source files (not in node_modules)', () => {
		const userFileIds = [
			'/project/src/routes/+page.svelte',
			'/Users/dev/app/src/lib/utils.ts',
			'C:/project/src/components/Button.svelte'
		];

		for (const id of userFileIds) {
			expect(id.includes('/node_modules/')).toBe(false);
		}
	});
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe('edge cases', () => {
	it('does not transform gg inside strings', () => {
		const code = `const s = 'gg("foo")'`;
		expect(transform(code)).toBeNull();
	});

	it('does not transform gg inside comments', () => {
		const code = `// gg("foo")`;
		expect(transform(code)).toBeNull();
	});

	it('handles multi-line gg() call', () => {
		const code = `function handleClick() {\n\tgg(\n\t\tsome.value\n\t)\n}`;
		const out = transform(code)!;
		expect(out).toContain("ns:'routes/+page.svelte@handleClick'");
		expect(out).toContain("file:'src/routes/+page.svelte'");
		expect(out).toContain('line:');
	});

	it('preserves file and line metadata in options object', () => {
		const code = `function test() { gg(data) }`;
		const out = transform(code)!;
		expect(out).toContain("file:'src/routes/+page.svelte'");
		expect(out).toContain('line:');
		expect(out).toContain('col:');
	});

	it('handles .svelte file with AST-based code ranges', () => {
		const code = `<script>\nfunction test() { gg(x) }\n</script>\n<p>gg("label")</p>`;
		const codeRanges = collectCodeRanges(code);
		const result = transformGgCalls(
			code,
			'routes/+page.svelte',
			'src/routes/+page.svelte',
			codeRanges
		);
		const out = result!.code;
		// Script: transformed with object literal syntax
		expect(out).toContain("{ns:'routes/+page.svelte@test'");
		// Template prose: left untouched (prose text, not a code expression)
		expect(out).toContain('gg("label")');
	});

	it('does not let HTML apostrophes break gg() in template expressions', () => {
		// Regression: an apostrophe in HTML prose (e.g. "Eruda's") was treated as
		// a JS string delimiter, causing the scanner to skip over a subsequent
		// gg() call inside an onclick handler.
		const code = `<script>
	import { gg } from '$lib/index.js';
</script>

<p>Check Eruda's GG tab.</p>
<button onclick={() => gg('event handler').ns('$NS:click')}>Click</button>`;
		const out = transform(code)!;
		expect(out).not.toBeNull();
		// gg('event handler') should be rewritten to gg._ns(...)
		expect(out).toContain('gg._ns(');
		// .ns('$NS:click') chain should be preserved as-is (runs at runtime)
		expect(out).toContain(".ns('$NS:click')");
	});

	it('does not rewrite removed static methods', () => {
		// gg.ns, gg.info, gg.warn, gg.error, gg.table, gg.trace, gg.assert
		// are no longer rewritten by the plugin (they were removed from the API)
		const code = `gg.ns('label', x)`;
		expect(transform(code)).toBeNull();
	});
});
