import type { Plugin } from 'vite';
import { parse } from 'svelte/compiler';

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

			// Quick bail: no gg calls in this file
			if (!code.includes('gg(') && !code.includes('gg.ns(')) return null;

			// Don't transform gg's own source files
			if (id.includes('/lib/gg.') || id.includes('/lib/debug')) return null;

			// Build the short callpoint from the file path (strips src/ prefix)
			// e.g. "/Users/me/project/src/routes/+page.svelte" → "routes/+page.svelte"
			const shortPath = id.replace(srcRootRegex, '');

			// Build the file path preserving src/ prefix (for open-in-editor)
			// e.g. "/Users/me/project/src/routes/+page.svelte" → "src/routes/+page.svelte"
			// $1 captures "/src/" or "/chunks/", so strip the leading slash
			const filePath = id.replace(srcRootRegex, '$1').replace(/^\//, '');

			// For .svelte files, use svelte.parse() AST to find code ranges.
			// This distinguishes real JS expressions ({gg()}, onclick, etc.)
			// from prose text mentioning "gg()".
			let codeRanges: CodeRange[] | undefined;
			if (/\.svelte(\?.*)?$/.test(id)) {
				codeRanges = collectCodeRanges(code);
				if (codeRanges.length === 0) return null;
			}

			return transformGgCalls(code, shortPath, filePath, codeRanges);
		}
	};
}

/**
 * Use `svelte.parse()` to collect all code ranges in a .svelte file.
 * Returns ranges for:
 * - `<script>` blocks (context: 'script')
 * - Template expressions: `{expr}`, `onclick={expr}`, `bind:value={expr}`,
 *   `class:name={expr}`, `{#if expr}`, `{#each expr}`, etc. (context: 'template')
 *
 * Text nodes (prose) are NOT included, so `gg()` in `<p>text gg()</p>` is never transformed.
 *
 * Falls back to regex-based script detection if `svelte.parse()` throws.
 */
export function collectCodeRanges(code: string): CodeRange[] {
	try {
		const ast = parse(code, { modern: true });
		const ranges: CodeRange[] = [];

		// Script blocks (instance + module)
		// The Svelte AST Program node has start/end at runtime but TypeScript's
		// estree Program type doesn't declare them — cast through any.
		if (ast.instance) {
			const content = ast.instance.content as any;
			ranges.push({ start: content.start, end: content.end, context: 'script' });
		}
		if (ast.module) {
			const content = ast.module.content as any;
			ranges.push({ start: content.start, end: content.end, context: 'script' });
		}

		// Walk the template fragment to find all expression positions
		walkFragment(ast.fragment, ranges);

		return ranges;
	} catch {
		// If svelte.parse() fails, the Svelte compiler will also reject this file,
		// so there's no point transforming gg() calls — return empty ranges.
		return [];
	}
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
 * Find the enclosing function name for a given position in source code.
 * Scans backwards from the position looking for function/method declarations.
 */
function findEnclosingFunction(code: string, position: number): string {
	// Look backwards from the gg( call for the nearest function declaration
	const before = code.slice(0, position);

	// Try several patterns, take the closest (last) match

	// Named function: function handleClick(
	// Arrow in variable: const handleClick = (...) =>
	// Arrow in variable: let handleClick = (...) =>
	// Method shorthand: handleClick() {
	// Method: handleClick: function(
	// Class method: async handleClick(

	const patterns = [
		// function declarations: function foo(
		/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
		// const/let/var assignment to arrow or function: const foo =
		/(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
		// object method shorthand: foo() { or async foo() {
		/(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{/g,
		// object property function: foo: function
		/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:async\s+)?function/g
	];

	let closestName = '';
	let closestPos = -1;

	for (const pattern of patterns) {
		let match;
		while ((match = pattern.exec(before)) !== null) {
			const name = match[1];
			// Skip common false positives
			if (
				[
					'if',
					'for',
					'while',
					'switch',
					'catch',
					'return',
					'import',
					'export',
					'from',
					'new',
					'typeof',
					'instanceof',
					'void',
					'delete',
					'throw',
					'case',
					'else',
					'in',
					'of',
					'do',
					'try',
					'class',
					'super',
					'this',
					'with',
					'yield',
					'await',
					'debugger',
					'default'
				].includes(name)
			) {
				continue;
			}
			if (match.index > closestPos) {
				closestPos = match.index;
				closestName = name;
			}
		}
	}

	return closestName;
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
 * For .svelte files, `codeRanges` (from `collectCodeRanges()`) determines which
 * positions contain JS code. Script ranges use `{...}` object literal syntax;
 * template ranges use `gg._o()` function-call syntax (no braces in Svelte markup).
 * Positions outside any code range (e.g. prose text) are skipped.
 */
export function transformGgCalls(
	code: string,
	shortPath: string,
	filePath: string,
	codeRanges?: CodeRange[]
): { code: string; map: null } | null {
	// We use a manual scan approach to correctly handle strings and comments.

	const result: string[] = [];
	let lastIndex = 0;
	let modified = false;
	const escapedFile = escapeForString(filePath);

	/**
	 * Find the code range containing `pos`, or undefined if outside all ranges.
	 * For non-.svelte files (no codeRanges), returns a synthetic 'script' range.
	 */
	function rangeAt(pos: number): CodeRange | undefined {
		if (!codeRanges) return { start: 0, end: code.length, context: 'script' };
		return findCodeRange(pos, codeRanges);
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
				// For template code, don't search backwards into script context for function names
				const fnName = range.context === 'template' ? '' : findEnclosingFunction(code, i);
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

			// Skip other gg.* calls (gg.enable, gg.disable, gg._ns, gg._onLog, etc.)
			if (code[i + 2] === '.') {
				i += 3;
				continue;
			}

			// Case 2: bare gg(...) → gg._ns({ns, file, line, col, src}, ...)
			if (code[i + 2] === '(') {
				const { line, col } = getLineCol(code, i);
				// For template code, don't search backwards into script context for function names
				const fnName = range.context === 'template' ? '' : findEnclosingFunction(code, i);
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
