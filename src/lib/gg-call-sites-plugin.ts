import type { Plugin } from 'vite';
import { parse } from 'svelte/compiler';
import * as acorn from 'acorn';
import { tsPlugin } from '@sveltejs/acorn-typescript';
import type { Program } from 'estree';

export interface GgCallSitesPluginOptions {
	/**
	 * Pattern to strip from file paths to produce short callpoints.
	 * Should match up to and including the source root folder.
	 *
	 * Default: /.*?(\/(?:src|chunks)\/)/ which strips everything up to "src/" or "chunks/",
	 * matching the dev-mode behavior of gg().
	 *
	 * Example: "/Users/me/project/src/routes/+page.svelte" → "routes/+page.svelte"
	 */
	srcRootPattern?: string;
}

/**
 * A range of source code that contains JS expressions, tagged with its context.
 * - 'script': inside a `<script>` block — use object literal `{...}` syntax
 * - 'template': inside a template expression `{...}` or event handler — use `gg._o()` syntax
 */
export interface CodeRange {
	start: number;
	end: number;
	context: 'script' | 'template';
}

/**
 * A function scope range, mapping a byte range to the enclosing function name.
 * Built from the estree AST during `collectCodeRanges()`.
 */
export interface FunctionScope {
	start: number;
	end: number;
	name: string;
}

/**
 * Result of `collectCodeRanges()` — code ranges plus function scope info.
 */
export interface SvelteCodeInfo {
	ranges: CodeRange[];
	/** Function scopes extracted from the estree AST, sorted by start position. */
	functionScopes: FunctionScope[];
}

/**
 * Vite plugin that rewrites `gg(...)` and `gg.ns(...)` calls to
 * `gg._ns({ns, file, line, col}, ...)` at build time. This gives each call
 * site a unique namespace plus source location metadata for open-in-editor
 * support, with zero runtime cost — no stack trace parsing needed.
 *
 * Works in both dev and prod. Without the plugin, gg() falls back to runtime
 * stack parsing in dev and bare `gg:` in prod.
 *
 * @example
 * // vite.config.ts
 * import { ggCallSitesPlugin } from '@leftium/gg';
 *
 * export default defineConfig({
 *   plugins: [ggCallSitesPlugin()]
 * });
 */
export default function ggCallSitesPlugin(options: GgCallSitesPluginOptions = {}): Plugin {
	const srcRootPattern = options.srcRootPattern ?? '.*?(/(?:src|chunks)/)';
	const srcRootRegex = new RegExp(srcRootPattern, 'i');

	return {
		name: 'gg-call-sites',
		enforce: 'pre' as const,

		config() {
			// Set a compile-time flag so gg() can detect the plugin is installed.
			// Vite replaces all occurrences of __GG_TAG_PLUGIN__ with true at build time,
			// before any code executes — no ordering issues.
			return {
				define: {
					__GG_TAG_PLUGIN__: 'true'
				}
			};
		},

		transform(code, id) {
			// Only process JS/TS/Svelte files
			if (!/\.(js|ts|svelte|jsx|tsx|mjs|mts)(\?.*)?$/.test(id)) return null;

			// Don't transform code inside node_modules
			// This prevents rewriting library code (including gg itself when published)
			if (id.includes('/node_modules/')) return null;

			// Don't transform the gg.ts file itself (contains gg function definitions)
			if (id.includes('/gg.ts') || id.includes('/gg.js')) return null;

			// Quick bail: no gg calls in this file
			if (
				!code.includes('gg(') &&
				!code.includes('gg.ns(') &&
				!code.includes('gg.info(') &&
				!code.includes('gg.warn(') &&
				!code.includes('gg.error(') &&
				!code.includes('gg.table(') &&
				!code.includes('gg.trace(') &&
				!code.includes('gg.assert(') &&
				!code.includes('gg.time(') &&
				!code.includes('gg.timeLog(') &&
				!code.includes('gg.timeEnd(')
			)
				return null;

			// Build the short callpoint from the file path (strips src/ prefix)
			// e.g. "/Users/me/project/src/routes/+page.svelte" → "routes/+page.svelte"
			const shortPath = id.replace(srcRootRegex, '');

			// Build the file path preserving src/ prefix (for open-in-editor)
			// e.g. "/Users/me/project/src/routes/+page.svelte" → "src/routes/+page.svelte"
			// $1 captures "/src/" or "/chunks/", so strip the leading slash
			const filePath = id.replace(srcRootRegex, '$1').replace(/^\//, '');

			// For .svelte files, use svelte.parse() AST to find code ranges
			// and function scopes. This distinguishes real JS expressions
			// ({gg()}, onclick, etc.) from prose text mentioning "gg()",
			// and uses estree AST for function name detection (no regex).
			let svelteInfo: SvelteCodeInfo | undefined;
			let jsFunctionScopes: FunctionScope[] | undefined;

			if (/\.svelte(\?.*)?$/.test(id)) {
				svelteInfo = collectCodeRanges(code);
				if (svelteInfo.ranges.length === 0) return null;
			} else {
				// For .js/.ts files, parse with acorn to extract function scopes
				jsFunctionScopes = parseJavaScript(code);
			}

			return transformGgCalls(code, shortPath, filePath, svelteInfo, jsFunctionScopes);
		}
	};
}

/**
 * Parse JavaScript/TypeScript code using acorn to extract function scopes.
 * Returns function scope ranges for accurate function name detection in .js/.ts files.
 * Uses @sveltejs/acorn-typescript plugin to handle TypeScript syntax.
 *
 * For .svelte files, use `collectCodeRanges()` instead (which uses svelte.parse()).
 */
export function parseJavaScript(code: string): FunctionScope[] {
	try {
		// Parse as ES2022+ with TypeScript support
		// sourceType: 'module' allows import/export, 'script' for regular scripts
		// NOTE: @sveltejs/acorn-typescript REQUIRES locations: true
		const parser = acorn.Parser.extend(tsPlugin());
		const ast = parser.parse(code, {
			ecmaVersion: 'latest',
			sourceType: 'module',
			locations: true, // Required by @sveltejs/acorn-typescript
			ranges: true // Enable byte ranges for AST nodes
		}) as unknown as Program & { start: number; end: number };

		const scopes: FunctionScope[] = [];
		// Reuse the same AST walker we built for Svelte
		collectFunctionScopes(ast.body as Program['body'], scopes);
		scopes.sort((a, b) => a.start - b.start);
		return scopes;
	} catch {
		// If acorn can't parse it, fall back to empty scopes.
		// The file might be malformed or use syntax we don't support yet.
		return [];
	}
}

/**
 * Use `svelte.parse()` to collect all code ranges and function scopes in a .svelte file.
 *
 * Code ranges identify where JS expressions live:
 * - `<script>` blocks (context: 'script')
 * - Template expressions: `{expr}`, `onclick={expr}`, `bind:value={expr}`,
 *   `class:name={expr}`, `{#if expr}`, `{#each expr}`, etc. (context: 'template')
 *
 * Function scopes are extracted from the estree AST in script blocks, mapping
 * byte ranges to enclosing function names. This replaces regex-based function
 * detection for .svelte files.
 *
 * Text nodes (prose) are NOT included, so `gg()` in `<p>text gg()</p>` is never transformed.
 */
export function collectCodeRanges(code: string): SvelteCodeInfo {
	try {
		const ast = parse(code, { modern: true });
		const ranges: CodeRange[] = [];
		const functionScopes: FunctionScope[] = [];

		// Script blocks (instance + module)
		// The Svelte AST Program node has start/end at runtime but TypeScript's
		// estree Program type doesn't declare them — we know they exist.
		if (ast.instance) {
			const content = ast.instance.content as Program & { start: number; end: number };
			ranges.push({ start: content.start, end: content.end, context: 'script' });
			collectFunctionScopes(ast.instance.content.body, functionScopes);
		}
		if (ast.module) {
			const content = ast.module.content as Program & { start: number; end: number };
			ranges.push({ start: content.start, end: content.end, context: 'script' });
			collectFunctionScopes(ast.module.content.body, functionScopes);
		}

		// Walk the template fragment to find all expression positions
		walkFragment(ast.fragment, ranges);

		// Sort function scopes by start position for efficient lookup
		functionScopes.sort((a, b) => a.start - b.start);

		return { ranges, functionScopes };
	} catch {
		// If svelte.parse() fails, the Svelte compiler will also reject this file,
		// so there's no point transforming gg() calls — return empty.
		return { ranges: [], functionScopes: [] };
	}
}

/**
 * Walk an estree AST body to collect function scope ranges.
 * Extracts function names from:
 * - FunctionDeclaration: `function foo() {}`
 * - VariableDeclarator with ArrowFunctionExpression/FunctionExpression: `const foo = () => {}`
 * - Property with FunctionExpression: `{ method() {} }` or `{ prop: function() {} }`
 * - MethodDefinition: `class Foo { bar() {} }`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectFunctionScopes(nodes: any[], scopes: FunctionScope[]): void {
	if (!nodes) return;
	for (const node of nodes) {
		collectFunctionScopesFromNode(node, scopes);
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectFunctionScopesFromNode(node: any, scopes: FunctionScope[]): void {
	if (!node || typeof node !== 'object' || !node.type) return;

	switch (node.type) {
		case 'ExportNamedDeclaration':
		case 'ExportDefaultDeclaration':
			// export function foo() {} or export default function foo() {}
			if (node.declaration) {
				collectFunctionScopesFromNode(node.declaration, scopes);
			}
			return;

		case 'FunctionDeclaration':
			if (node.id?.name && node.body) {
				scopes.push({ start: node.body.start, end: node.body.end, name: node.id.name });
			}
			// Recurse into the function body for nested functions
			if (node.body?.body) collectFunctionScopes(node.body.body, scopes);
			return;

		case 'VariableDeclaration':
			for (const decl of node.declarations || []) {
				collectFunctionScopesFromNode(decl, scopes);
			}
			return;

		case 'VariableDeclarator':
			// const foo = () => {} or const foo = function() {}
			if (
				node.id?.name &&
				node.init &&
				(node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')
			) {
				const body = node.init.body;
				if (body) {
					// Arrow with block body: () => { ... }
					// Arrow with expression body: () => expr  (use the arrow's range)
					const start = body.type === 'BlockStatement' ? body.start : node.init.start;
					const end = body.type === 'BlockStatement' ? body.end : node.init.end;
					scopes.push({ start, end, name: node.id.name });
				}
				// Recurse into the function body
				if (body?.body) collectFunctionScopes(body.body, scopes);
			}
			// Recurse into object/array initializers for nested functions
			if (node.init) collectFunctionScopesFromNode(node.init, scopes);
			return;

		case 'ExpressionStatement':
			collectFunctionScopesFromNode(node.expression, scopes);
			return;

		case 'ObjectExpression':
			for (const prop of node.properties || []) {
				collectFunctionScopesFromNode(prop, scopes);
			}
			return;

		case 'Property':
			// { method() {} } or { prop: function() {} }
			if (
				node.key?.name &&
				node.value &&
				(node.value.type === 'FunctionExpression' || node.value.type === 'ArrowFunctionExpression')
			) {
				const body = node.value.body;
				if (body) {
					const start = body.type === 'BlockStatement' ? body.start : node.value.start;
					const end = body.type === 'BlockStatement' ? body.end : node.value.end;
					scopes.push({ start, end, name: node.key.name });
				}
				if (body?.body) collectFunctionScopes(body.body, scopes);
			}
			return;

		case 'MethodDefinition':
			// class Foo { bar() {} }
			if (node.key?.name && node.value?.body) {
				scopes.push({
					start: node.value.body.start,
					end: node.value.body.end,
					name: node.key.name
				});
				if (node.value.body?.body) collectFunctionScopes(node.value.body.body, scopes);
			}
			return;

		case 'ClassDeclaration':
		case 'ClassExpression':
			if (node.body?.body) {
				for (const member of node.body.body) {
					collectFunctionScopesFromNode(member, scopes);
				}
			}
			return;

		case 'IfStatement':
			if (node.consequent) collectFunctionScopesFromNode(node.consequent, scopes);
			if (node.alternate) collectFunctionScopesFromNode(node.alternate, scopes);
			return;

		case 'BlockStatement':
			if (node.body) collectFunctionScopes(node.body, scopes);
			return;

		case 'ForStatement':
		case 'ForInStatement':
		case 'ForOfStatement':
		case 'WhileStatement':
		case 'DoWhileStatement':
			if (node.body) collectFunctionScopesFromNode(node.body, scopes);
			return;

		case 'TryStatement':
			if (node.block) collectFunctionScopesFromNode(node.block, scopes);
			if (node.handler?.body) collectFunctionScopesFromNode(node.handler.body, scopes);
			if (node.finalizer) collectFunctionScopesFromNode(node.finalizer, scopes);
			return;

		case 'SwitchStatement':
			for (const c of node.cases || []) {
				if (c.consequent) collectFunctionScopes(c.consequent, scopes);
			}
			return;

		case 'ReturnStatement':
			if (node.argument) collectFunctionScopesFromNode(node.argument, scopes);
			return;

		case 'CallExpression':
			// e.g. onMount(() => { gg() })
			for (const arg of node.arguments || []) {
				if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
					// Anonymous callback — don't add a scope (no name to show),
					// but recurse for nested named functions
					if (arg.body?.body) collectFunctionScopes(arg.body.body, scopes);
				}
			}
			return;
	}
}

/**
 * Find the innermost enclosing function name for a byte position
 * using the pre-built function scope map.
 * Returns empty string if not inside any named function.
 */
export function findEnclosingFunctionFromScopes(pos: number, scopes: FunctionScope[]): string {
	// Scopes can be nested; find the innermost (smallest range) that contains pos
	let bestName = '';
	let bestSize = Infinity;
	for (const scope of scopes) {
		if (pos >= scope.start && pos < scope.end) {
			const size = scope.end - scope.start;
			if (size < bestSize) {
				bestSize = size;
				bestName = scope.name;
			}
		}
	}
	return bestName;
}

/**
 * Recursively walk a Svelte AST fragment to collect template expression ranges.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkFragment(fragment: any, ranges: CodeRange[]): void {
	if (!fragment?.nodes) return;
	for (const node of fragment.nodes) {
		walkNode(node, ranges);
	}
}

/**
 * Walk a single AST node, collecting expression ranges for template code.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkNode(node: any, ranges: CodeRange[]): void {
	if (!node || typeof node !== 'object') return;

	switch (node.type) {
		// Template expression tags: {expr}
		case 'ExpressionTag':
		case 'HtmlTag':
		case 'RenderTag':
		case 'AttachTag':
			if (node.expression && node.start != null && node.end != null) {
				ranges.push({ start: node.start, end: node.end, context: 'template' });
			}
			return; // expressions are leaf nodes for our purposes

		// Block tags with expressions: {#if expr}, {#each expr}, {#await expr}, {#key expr}
		case 'IfBlock':
			if (node.test) addExprRange(node.test, ranges);
			walkFragment(node.consequent, ranges);
			if (node.alternate) walkFragment(node.alternate, ranges);
			return;
		case 'EachBlock':
			if (node.expression) addExprRange(node.expression, ranges);
			if (node.key) addExprRange(node.key, ranges);
			walkFragment(node.body, ranges);
			if (node.fallback) walkFragment(node.fallback, ranges);
			return;
		case 'AwaitBlock':
			if (node.expression) addExprRange(node.expression, ranges);
			walkFragment(node.pending, ranges);
			walkFragment(node.then, ranges);
			walkFragment(node.catch, ranges);
			return;
		case 'KeyBlock':
			if (node.expression) addExprRange(node.expression, ranges);
			walkFragment(node.fragment, ranges);
			return;
		case 'SnippetBlock':
			walkFragment(node.body, ranges);
			return;

		// {@const ...} — contains a declaration, not a simple expression
		case 'ConstTag':
			if (node.declaration) {
				ranges.push({ start: node.start, end: node.end, context: 'template' });
			}
			return;

		// Elements and components — walk attributes + children
		case 'RegularElement':
		case 'Component':
		case 'SvelteElement':
		case 'SvelteComponent':
		case 'SvelteBody':
		case 'SvelteWindow':
		case 'SvelteDocument':
		case 'SvelteHead':
		case 'SvelteSelf':
		case 'SvelteFragment':
		case 'SvelteBoundary':
		case 'TitleElement':
		case 'SlotElement':
			walkAttributes(node.attributes, ranges);
			walkFragment(node.fragment, ranges);
			return;

		// Text nodes — skip (prose, not code)
		case 'Text':
		case 'Comment':
			return;

		default:
			// Unknown node type — try to walk children defensively
			if (node.fragment) walkFragment(node.fragment, ranges);
			if (node.children) walkFragment({ nodes: node.children }, ranges);
			return;
	}
}

/**
 * Walk element attributes to find expression ranges.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkAttributes(attrs: any[], ranges: CodeRange[]): void {
	if (!attrs) return;
	for (const attr of attrs) {
		switch (attr.type) {
			case 'Attribute':
				// value can be: true | ExpressionTag | Array<Text | ExpressionTag>
				if (attr.value === true) break;
				if (Array.isArray(attr.value)) {
					for (const part of attr.value) {
						if (part.type === 'ExpressionTag') {
							ranges.push({ start: part.start, end: part.end, context: 'template' });
						}
					}
				} else if (attr.value?.type === 'ExpressionTag') {
					ranges.push({ start: attr.value.start, end: attr.value.end, context: 'template' });
				}
				break;
			case 'SpreadAttribute':
				if (attr.expression) {
					ranges.push({ start: attr.start, end: attr.end, context: 'template' });
				}
				break;
			// Directives: bind:, class:, style:, on:, use:, transition:, animate:, attach:
			case 'BindDirective':
			case 'ClassDirective':
			case 'StyleDirective':
			case 'OnDirective':
			case 'UseDirective':
			case 'TransitionDirective':
			case 'AnimateDirective':
				if (attr.expression) {
					addExprRange(attr.expression, ranges);
				}
				// StyleDirective value can be an array
				if (attr.value && Array.isArray(attr.value)) {
					for (const part of attr.value) {
						if (part.type === 'ExpressionTag') {
							ranges.push({ start: part.start, end: part.end, context: 'template' });
						}
					}
				}
				break;
			case 'AttachTag':
				if (attr.expression) {
					ranges.push({ start: attr.start, end: attr.end, context: 'template' });
				}
				break;
		}
	}
}

/**
 * Add a template expression range from an AST expression node.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addExprRange(expr: any, ranges: CodeRange[]): void {
	if (expr && expr.start != null && expr.end != null) {
		ranges.push({ start: expr.start, end: expr.end, context: 'template' });
	}
}

/**
 * Check if a character position falls within any of the given code ranges.
 * Returns the matching range, or undefined if not in any range.
 */
function findCodeRange(pos: number, ranges: CodeRange[]): CodeRange | undefined {
	for (const r of ranges) {
		if (pos >= r.start && pos < r.end) return r;
	}
	return undefined;
}

/**
 * Compute 1-based line number and column for a character offset in source code.
 */
function getLineCol(code: string, offset: number): { line: number; col: number } {
	const line = code.slice(0, offset).split('\n').length;
	const col = offset - code.lastIndexOf('\n', offset - 1);
	return { line, col };
}

/**
 * Find the matching closing paren for an opening paren at `openPos`.
 * Handles nested parens, brackets, braces, strings, template literals, and comments.
 * Returns the index of the closing ')' or -1 if not found.
 */
function findMatchingParen(code: string, openPos: number): number {
	let depth = 1;
	let j = openPos + 1;
	while (j < code.length && depth > 0) {
		const ch = code[j];

		// Skip string literals
		if (ch === '"' || ch === "'") {
			j++;
			while (j < code.length && code[j] !== ch) {
				if (code[j] === '\\') j++;
				j++;
			}
			j++; // skip closing quote
			continue;
		}

		// Skip template literals
		if (ch === '`') {
			j++;
			let tmplDepth = 0;
			while (j < code.length) {
				if (code[j] === '\\') {
					j += 2;
					continue;
				}
				if (code[j] === '$' && code[j + 1] === '{') {
					tmplDepth++;
					j += 2;
					continue;
				}
				if (code[j] === '}' && tmplDepth > 0) {
					tmplDepth--;
					j++;
					continue;
				}
				if (code[j] === '`' && tmplDepth === 0) {
					j++;
					break;
				}
				j++;
			}
			continue;
		}

		// Skip single-line comments
		if (ch === '/' && code[j + 1] === '/') {
			const end = code.indexOf('\n', j);
			j = end === -1 ? code.length : end + 1;
			continue;
		}

		// Skip multi-line comments
		if (ch === '/' && code[j + 1] === '*') {
			const end = code.indexOf('*/', j + 2);
			j = end === -1 ? code.length : end + 2;
			continue;
		}

		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;

		if (depth > 0) j++;
	}
	return depth === 0 ? j : -1;
}

/**
 * Escape a string for embedding as a single-quoted JS string literal.
 */
export function escapeForString(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/**
 * Transform gg() and gg.ns() calls in source code to gg._ns({ns, file, line, col, src}, ...) calls.
 *
 * Handles:
 * - bare gg(expr) → gg._ns({ns, file, line, col, src: 'expr'}, expr)
 * - gg.ns('label', expr) → gg._ns({ns, file, line, col, src: 'expr'}, expr)
 *   - label supports template variables: $NS, $FN, $FILE, $LINE, $COL
 *   - plain label (no variables) is used as-is (no auto @fn append)
 * - gg.enable, gg.disable, gg.clearPersist, gg._onLog, gg._ns → left untouched
 * - gg inside strings and comments → left untouched
 *
 * For .svelte files, `svelteInfo` (from `collectCodeRanges()`) determines which
 * positions contain JS code and provides AST-based function scope detection.
 * Script ranges use `{...}` object literal syntax; template ranges use `gg._o()`
 * function-call syntax (no braces in Svelte markup). Positions outside any code
 * range (e.g. prose text) are skipped.
 *
 * For .js/.ts files, `jsFunctionScopes` (from `parseJavaScript()`) provides
 * AST-based function scope detection (no regex fallback).
 */
export function transformGgCalls(
	code: string,
	shortPath: string,
	filePath: string,
	svelteInfo?: SvelteCodeInfo,
	jsFunctionScopes?: FunctionScope[]
): { code: string; map: null } | null {
	// We use a manual scan approach to correctly handle strings and comments.

	const result: string[] = [];
	let lastIndex = 0;
	let modified = false;
	const escapedFile = escapeForString(filePath);

	/**
	 * Find the code range containing `pos`, or undefined if outside all ranges.
	 * For non-.svelte files (no svelteInfo), returns a synthetic 'script' range.
	 */
	function rangeAt(pos: number): CodeRange | undefined {
		if (!svelteInfo) return { start: 0, end: code.length, context: 'script' };
		return findCodeRange(pos, svelteInfo.ranges);
	}

	/**
	 * Find the enclosing function name for a position.
	 * - .svelte files: uses estree AST function scope map from svelte.parse()
	 * - .js/.ts files: uses estree AST function scope map from acorn.parse()
	 * - template code ranges: always returns '' (no enclosing function from script)
	 */
	function getFunctionName(pos: number, range: CodeRange): string {
		if (range.context === 'template') return '';
		if (svelteInfo) return findEnclosingFunctionFromScopes(pos, svelteInfo.functionScopes);
		if (jsFunctionScopes) return findEnclosingFunctionFromScopes(pos, jsFunctionScopes);
		return ''; // Should not reach here unless both svelteInfo and jsFunctionScopes are undefined
	}

	/**
	 * Build the options argument for gg._ns().
	 * Inside <script>:  {ns:'...',file:'...',line:N,col:N}           (object literal)
	 * In template:      gg._o('...','...',N,N)                       (function call — no braces)
	 */
	function buildOptions(
		range: CodeRange,
		ns: string,
		line: number,
		col: number,
		src?: string
	): string {
		if (range.context === 'script') {
			return src
				? `{ns:'${ns}',file:'${escapedFile}',line:${line},col:${col},src:'${src}'}`
				: `{ns:'${ns}',file:'${escapedFile}',line:${line},col:${col}}`;
		}
		return src
			? `gg._o('${ns}','${escapedFile}',${line},${col},'${src}')`
			: `gg._o('${ns}','${escapedFile}',${line},${col})`;
	}

	// States for string/comment tracking
	let i = 0;
	while (i < code.length) {
		// For .svelte files, only apply JS string/comment/backtick skipping inside
		// code ranges (script blocks + template expressions). Outside code ranges,
		// characters like ' " ` // /* are just HTML prose — NOT JS syntax.
		// e.g. "Eruda's" contains an apostrophe that is NOT a JS string delimiter.
		const inCodeRange = !svelteInfo || !!rangeAt(i);

		if (inCodeRange) {
			// Skip single-line comments
			if (code[i] === '/' && code[i + 1] === '/') {
				const end = code.indexOf('\n', i);
				i = end === -1 ? code.length : end + 1;
				continue;
			}

			// Skip multi-line comments
			if (code[i] === '/' && code[i + 1] === '*') {
				const end = code.indexOf('*/', i + 2);
				i = end === -1 ? code.length : end + 2;
				continue;
			}

			// Skip template literals (backticks)
			if (code[i] === '`') {
				i++;
				let depth = 0;
				while (i < code.length) {
					if (code[i] === '\\') {
						i += 2;
						continue;
					}
					if (code[i] === '$' && code[i + 1] === '{') {
						depth++;
						i += 2;
						continue;
					}
					if (code[i] === '}' && depth > 0) {
						depth--;
						i++;
						continue;
					}
					if (code[i] === '`' && depth === 0) {
						i++;
						break;
					}
					i++;
				}
				continue;
			}

			// Skip strings (single and double quotes)
			if (code[i] === '"' || code[i] === "'") {
				const quote = code[i];
				i++;
				while (i < code.length) {
					if (code[i] === '\\') {
						i += 2;
						continue;
					}
					if (code[i] === quote) {
						i++;
						break;
					}
					i++;
				}
				continue;
			}
		}

		// Look for 'gg' pattern — could be gg( or gg.ns(
		if (code[i] === 'g' && code[i + 1] === 'g') {
			// In .svelte files, skip gg outside code ranges (prose text, etc.)
			const range = rangeAt(i);
			if (!range) {
				i++;
				continue;
			}

			// Check preceding character: must not be a word char or dot
			const prevChar = i > 0 ? code[i - 1] : '';
			if (prevChar && /[a-zA-Z0-9_$.]/.test(prevChar)) {
				i++;
				continue;
			}

			// Case 1: gg.ns('label', ...) → gg._ns({ns: 'label', file, line, col, src}, ...)
			if (code.slice(i + 2, i + 6) === '.ns(') {
				const { line, col } = getLineCol(code, i);
				const fnName = getFunctionName(i, range);
				const openParenPos = i + 5; // position of '(' in 'gg.ns('

				// Find matching closing paren for the entire gg.ns(...) call
				const closeParenPos = findMatchingParen(code, openParenPos);
				if (closeParenPos === -1) {
					i += 6;
					continue;
				}

				// Extract the first argument (the namespace string)
				// Look for the string literal after 'gg.ns('
				const afterNsParen = i + 6; // position after 'gg.ns('
				const quoteChar = code[afterNsParen];

				if (quoteChar === "'" || quoteChar === '"') {
					// Find the closing quote
					let j = afterNsParen + 1;
					while (j < code.length && code[j] !== quoteChar) {
						if (code[j] === '\\') j++; // skip escaped chars
						j++;
					}
					// j now points to closing quote
					const nsLabelRaw = code.slice(afterNsParen + 1, j);

					// Build callpoint: substitute $NS/$FN/$FILE/$LINE/$COL template variables.
					// The auto-generated callpoint (file@fn) is what bare gg() would produce.
					const autoCallpoint = `${shortPath}${fnName ? `@${fnName}` : ''}`;
					const callpoint = escapeForString(
						nsLabelRaw
							.replace(/\$NS/g, autoCallpoint)
							.replace(/\$FN/g, fnName)
							.replace(/\$FILE/g, shortPath)
							.replace(/\$LINE/g, String(line))
							.replace(/\$COL/g, String(col))
					);

					// Check if there are more args after the string
					const afterClosingQuote = j + 1;
					let k = afterClosingQuote;
					while (k < code.length && /\s/.test(code[k])) k++;

					if (code[k] === ')') {
						// gg.ns('label') → gg._ns(opts)
						result.push(code.slice(lastIndex, i));
						result.push(`gg._ns(${buildOptions(range, callpoint, line, col)})`);
						lastIndex = k + 1;
						i = k + 1;
					} else if (code[k] === ',') {
						// gg.ns('label', args...) → gg._ns(opts, args...)
						let argsStart = k + 1;
						while (argsStart < closeParenPos && /\s/.test(code[argsStart])) argsStart++;
						const argsSrc = code.slice(argsStart, closeParenPos).trim();
						const escapedSrc = escapeForString(argsSrc);
						result.push(code.slice(lastIndex, i));
						result.push(`gg._ns(${buildOptions(range, callpoint, line, col, escapedSrc)}, `);
						lastIndex = k + 1; // skip past the comma, keep args as-is
						i = k + 1;
					} else {
						// Unexpected — leave untouched
						i += 6;
						continue;
					}

					modified = true;
					continue;
				}

				// Non-string first arg to gg.ns — skip (can't extract ns at build time)
				i += 6;
				continue;
			}

			// Case 1b: gg.info/warn/error/table/trace/assert → gg._info/_warn/_error/_table/_trace/_assert
			// These methods are rewritten like bare gg() but with their internal variant.
			const dotMethodMatch = code
				.slice(i + 2)
				.match(/^\.(info|warn|error|table|trace|assert|time|timeLog|timeEnd)\(/);
			if (dotMethodMatch) {
				const methodName = dotMethodMatch[1];
				const internalName = `_${methodName}`;
				const methodCallLen = 2 + 1 + methodName.length + 1; // 'gg' + '.' + method + '('
				const openParenPos = i + methodCallLen - 1;

				const { line, col } = getLineCol(code, i);
				const fnName = getFunctionName(i, range);
				const callpoint = `${shortPath}${fnName ? `@${fnName}` : ''}`;
				const escapedNs = escapeForString(callpoint);

				const closeParenPos = findMatchingParen(code, openParenPos);
				if (closeParenPos === -1) {
					i += methodCallLen;
					continue;
				}

				const argsText = code.slice(openParenPos + 1, closeParenPos).trim();

				result.push(code.slice(lastIndex, i));

				if (argsText === '') {
					// gg.warn() → gg._warn(opts)
					result.push(`gg.${internalName}(${buildOptions(range, escapedNs, line, col)})`);
					lastIndex = closeParenPos + 1;
					i = closeParenPos + 1;
				} else {
					// gg.warn(expr) → gg._warn(opts, expr)
					const escapedSrc = escapeForString(argsText);
					result.push(
						`gg.${internalName}(${buildOptions(range, escapedNs, line, col, escapedSrc)}, `
					);
					lastIndex = openParenPos + 1; // keep original args
					i = openParenPos + 1;
				}
				modified = true;
				continue;
			}

			// Skip other gg.* calls (gg.enable, gg.disable, gg._ns, gg._onLog, gg.time, etc.)
			if (code[i + 2] === '.') {
				i += 3;
				continue;
			}

			// Case 2: bare gg(...) → gg._ns({ns, file, line, col, src}, ...)
			if (code[i + 2] === '(') {
				const { line, col } = getLineCol(code, i);
				const fnName = getFunctionName(i, range);
				const callpoint = `${shortPath}${fnName ? `@${fnName}` : ''}`;
				const escapedNs = escapeForString(callpoint);
				const openParenPos = i + 2; // position of '(' in 'gg('

				// Find matching closing paren
				const closeParenPos = findMatchingParen(code, openParenPos);
				if (closeParenPos === -1) {
					i += 3;
					continue;
				}

				const argsText = code.slice(openParenPos + 1, closeParenPos).trim();

				// Emit everything before this match
				result.push(code.slice(lastIndex, i));

				if (argsText === '') {
					// gg() → gg._ns(opts)
					result.push(`gg._ns(${buildOptions(range, escapedNs, line, col)})`);
					lastIndex = closeParenPos + 1;
					i = closeParenPos + 1;
				} else {
					// gg(expr) → gg._ns(opts, expr)
					const escapedSrc = escapeForString(argsText);
					result.push(`gg._ns(${buildOptions(range, escapedNs, line, col, escapedSrc)}, `);
					lastIndex = openParenPos + 1; // keep original args
					i = openParenPos + 1;
				}
				modified = true;
				continue;
			}

			i++;
			continue;
		}

		i++;
	}

	if (!modified) return null;

	result.push(code.slice(lastIndex));
	return { code: result.join(''), map: null };
}
