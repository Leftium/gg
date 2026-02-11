import type { Plugin } from 'vite';

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

			// For .svelte files (with enforce:'pre', we see raw source), detect
			// <script> blocks. Currently only transforms inside <script>.
			// Template expressions (e.g. {gg()}, onclick={() => gg()}) are
			// skipped — they use the runtime fallback. gg._o() helper exists
			// for future AST-based template transform (svelte.parse).
			let scriptRanges: Array<{ start: number; end: number }> | undefined;
			if (/\.svelte(\?.*)?$/.test(id)) {
				scriptRanges = findScriptRanges(code);
				if (scriptRanges.length === 0) return null;
			}

			return transformGgCalls(code, shortPath, filePath, scriptRanges);
		}
	};
}

/**
 * Find the start/end byte offsets of all <script> blocks in a .svelte file.
 * Returns ranges covering the inner content (after the opening tag, before </script>).
 */
function findScriptRanges(code: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	// Match <script ...> tags (with optional attributes like lang="ts")
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

/**
 * Check if a character position falls within any of the given ranges.
 */
function isInRanges(pos: number, ranges: Array<{ start: number; end: number }>): boolean {
	for (const r of ranges) {
		if (pos >= r.start && pos < r.end) return true;
	}
	return false;
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
 */
export function transformGgCalls(
	code: string,
	shortPath: string,
	filePath: string,
	scriptRanges?: Array<{ start: number; end: number }>
): { code: string; map: null } | null {
	// We use a manual scan approach to correctly handle strings and comments.

	const result: string[] = [];
	let lastIndex = 0;
	let modified = false;
	const escapedFile = escapeForString(filePath);

	/** Check if position is inside a <script> block (or not in a .svelte file) */
	const inScript = (pos: number): boolean => !scriptRanges || isInRanges(pos, scriptRanges);

	/**
	 * Build the options argument for gg._ns().
	 * Inside <script>:  {ns:'...',file:'...',line:N,col:N}           (object literal)
	 * In template:      gg._o('...','...',N,N)                       (function call — no braces)
	 */
	function buildOptions(pos: number, ns: string, line: number, col: number, src?: string): string {
		if (inScript(pos)) {
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
			// In .svelte files, skip gg outside <script> blocks for now.
			// Template expressions like {gg()} would need AST-based detection
			// (svelte.parse) to distinguish from plain text like "gg() demo".
			// TODO: use svelte.parse() AST to find ExpressionTag nodes and
			// transform those with gg._o() syntax.
			if (scriptRanges && !inScript(i)) {
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
				const fnName = findEnclosingFunction(code, i);
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
						result.push(`gg._ns(${buildOptions(i, callpoint, line, col)})`);
						lastIndex = k + 1;
						i = k + 1;
					} else if (code[k] === ',') {
						// gg.ns('label', args...) → gg._ns(opts, args...)
						let argsStart = k + 1;
						while (argsStart < closeParenPos && /\s/.test(code[argsStart])) argsStart++;
						const argsSrc = code.slice(argsStart, closeParenPos).trim();
						const escapedSrc = escapeForString(argsSrc);
						result.push(code.slice(lastIndex, i));
						result.push(`gg._ns(${buildOptions(i, callpoint, line, col, escapedSrc)}, `);
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
				const fnName = findEnclosingFunction(code, i);
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
					result.push(`gg._ns(${buildOptions(i, escapedNs, line, col)})`);
					lastIndex = closeParenPos + 1;
					i = closeParenPos + 1;
				} else {
					// gg(expr) → gg._ns(opts, expr)
					const escapedSrc = escapeForString(argsText);
					result.push(`gg._ns(${buildOptions(i, escapedNs, line, col, escapedSrc)}, `);
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
