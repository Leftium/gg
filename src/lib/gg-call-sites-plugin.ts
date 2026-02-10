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
 * Vite plugin that rewrites bare `gg(...)` calls to `gg.ns('callpoint', ...)`
 * at build time. This gives each call site a unique namespace with zero runtime
 * cost — no stack trace parsing needed.
 *
 * Works in both dev and prod. When the plugin is installed, `gg.ns()` is called
 * with the callpoint baked in as a string literal. Without the plugin, gg()
 * falls back to runtime stack parsing in dev and bare `gg:` in prod.
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
			if (!code.includes('gg(')) return null;

			// Don't transform gg's own source files
			if (id.includes('/lib/gg.') || id.includes('/lib/debug')) return null;

			// Build the short callpoint from the file path
			// e.g. "/Users/me/project/src/routes/+page.svelte" → "routes/+page.svelte"
			const shortPath = id.replace(srcRootRegex, '');

			return transformGgCalls(code, shortPath);
		}
	};
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
 * Transform gg() calls in source code to gg.ns('callpoint', ...) calls.
 *
 * Handles:
 * - bare gg(...) → gg.ns('callpoint', ...)
 * - gg.ns(...) → left untouched (user-specified namespace)
 * - gg.enable, gg.disable, gg.clearPersist, gg._onLog → left untouched
 * - gg inside strings and comments → left untouched
 */
function transformGgCalls(code: string, shortPath: string): { code: string; map: null } | null {
	// Match gg( that is:
	// - not preceded by a dot (would be obj.gg() — not our function)
	// - not preceded by a word char (would be dogg() or something)
	// - not followed by a dot before the paren (gg.ns, gg.enable, etc.)
	//
	// We use a manual scan approach to correctly handle strings and comments.

	const result: string[] = [];
	let lastIndex = 0;
	let modified = false;

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

		// Look for 'gg(' pattern
		if (code[i] === 'g' && code[i + 1] === 'g' && code[i + 2] === '(') {
			// Check preceding character: must not be a word char or dot
			const prevChar = i > 0 ? code[i - 1] : '';
			if (prevChar && /[a-zA-Z0-9_$.]/.test(prevChar)) {
				i++;
				continue;
			}

			// Check it's not gg.something (gg.ns, gg.enable, etc.)
			// At this point we know code[i..i+2] is "gg(" — it's a bare call

			// Find the enclosing function
			const fnName = findEnclosingFunction(code, i);
			const callpoint = `${shortPath}${fnName ? `@${fnName}` : ''}`;
			const escaped = callpoint.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

			// Emit everything before this match
			result.push(code.slice(lastIndex, i));
			// Replace gg( with gg.ns('callpoint',
			// Need to handle gg() with no args → gg.ns('callpoint')
			// and gg(x) → gg.ns('callpoint', x)

			// Peek ahead to check if it's gg() with no args
			const afterParen = code.indexOf(')', i + 3);
			const betweenParens = code.slice(i + 3, afterParen);
			const isNoArgs = betweenParens.trim() === '';

			if (isNoArgs && afterParen !== -1 && !betweenParens.includes('(')) {
				// gg() → gg.ns('callpoint')
				result.push(`gg.ns('${escaped}')`);
				lastIndex = afterParen + 1;
				i = afterParen + 1;
			} else {
				// gg(args...) → gg.ns('callpoint', args...)
				result.push(`gg.ns('${escaped}', `);
				lastIndex = i + 3; // skip past "gg("
				i = i + 3;
			}
			modified = true;
			continue;
		}

		i++;
	}

	if (!modified) return null;

	result.push(code.slice(lastIndex));
	return { code: result.join(''), map: null };
}
