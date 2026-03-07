/**
 * Shared namespace pattern matching used by both the Eruda plugin and the
 * gg-file-sink plugin.
 *
 * Patterns are comma-separated globs. A `-` prefix marks an exclusion:
 *   "gg:*"            — all gg namespaces
 *   "gg:api:*,-gg:api:verbose:*"  — gg:api:* except verbose
 */

/**
 * Test whether `str` matches a single glob `pattern`.
 * Supports `*` as a wildcard. Both sides are trimmed before comparison
 * (namespaces may have trailing spaces from padEnd in the Eruda display).
 */
export function matchesGlob(str: string, pattern: string): boolean {
	const s = str.trim();
	const p = pattern.trim();
	const regexPattern = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	const regex = new RegExp(`^${regexPattern}$`);
	return regex.test(s);
}

/**
 * Test whether `ns` matches a comma-separated pattern string.
 *
 * - Empty pattern, `*`, or `gg:*` → always true (fast path).
 * - Inclusions (no `-` prefix) are OR-ed; at least one must match.
 * - Exclusions (`-` prefix) take priority: any match → false.
 * - If the pattern contains only exclusions, `ns` is included by default.
 */
export function matchesPattern(ns: string, pattern: string): boolean {
	if (!pattern || pattern === '*' || pattern === 'gg:*') return true;
	const parts = pattern
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);
	const inclusions = parts.filter((p) => !p.startsWith('-'));
	const exclusions = parts.filter((p) => p.startsWith('-')).map((p) => p.slice(1));

	const included = inclusions.length === 0 || inclusions.some((p) => matchesGlob(ns, p));
	const excluded = exclusions.some((p) => matchesGlob(ns, p));
	return included && !excluded;
}
