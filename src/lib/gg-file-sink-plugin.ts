import type { Plugin } from 'vite';
import * as fs from 'fs';
import * as path from 'path';
import type { CapturedEntry } from './eruda/types.js';
import { gg } from './gg.js';

export interface GgFileSinkOptions {
	/** Directory to write log files into. Defaults to `.gg/` in the project root. */
	dir?: string;
}

/** Subset of CapturedEntry fields written to the JSONL file. */
interface SerializedEntry {
	ns: string;
	msg: string;
	ts: number;
	lvl?: string;
	env: 'client' | 'server';
	origin?: 'tauri' | 'browser';
	file?: string;
	line?: number;
	src?: string;
	diff: number;
	table?: { keys: string[]; rows: Array<Record<string, unknown>> };
}

function serializeEntry(
	entry: CapturedEntry,
	env: 'client' | 'server',
	origin?: 'tauri' | 'browser'
): SerializedEntry {
	const out: SerializedEntry = {
		ns: entry.namespace,
		msg: entry.message,
		ts: entry.timestamp,
		env,
		diff: entry.diff
	};
	if (entry.level && entry.level !== 'debug') out.lvl = entry.level;
	if (origin) out.origin = origin;
	if (entry.file) out.file = entry.file;
	if (entry.line !== undefined) out.line = entry.line;
	if (entry.src) out.src = entry.src;
	if (entry.tableData) out.table = entry.tableData;
	return out;
}

function matchesGlob(str: string, pattern: string): boolean {
	const s = str.trim();
	const p = pattern.trim();
	const regexPattern = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	const regex = new RegExp(`^${regexPattern}$`);
	return regex.test(s);
}

/**
 * Match a namespace against a comma-separated pattern string (same logic as Eruda plugin).
 * Supports inclusions and exclusions (prefixed with `-`).
 */
function matchesPattern(ns: string, pattern: string): boolean {
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

/**
 * Pre-dedup field filters: namespace glob and timestamp.
 * Applied before dedup/mismatch so the index sees all entries for a call site.
 */
function filterLinePreDedup(line: string, params: URLSearchParams): boolean {
	let entry: SerializedEntry;
	try {
		entry = JSON.parse(line);
	} catch {
		return false;
	}

	const filter = params.get('filter');
	if (filter && !matchesPattern(entry.ns, filter)) return false;

	const since = params.get('since');
	if (since && entry.ts < Number(since)) return false;

	return true;
}

/**
 * Post-dedup field filters: env and origin.
 * Applied after dedup/mismatch so cross-env comparisons see both sides first.
 * e.g. ?mismatch&env=server correctly returns the server half of mismatch pairs.
 */
function filterEntryPostDedup(entry: SerializedEntry, params: URLSearchParams): boolean {
	const env = params.get('env');
	if (env && entry.env !== env) return false;

	const origin = params.get('origin');
	if (origin && entry.origin !== origin) return false;

	return true;
}

/**
 * Dedup key for an entry: namespace + line number.
 * Two entries with the same key are the "same call site" — server and client
 * rendering the same gg() call. If their msg also matches they're identical;
 * if msg differs they're a hydration mismatch.
 */
function dedupKey(entry: SerializedEntry): string {
	return `${entry.ns}\0${entry.line ?? ''}`;
}

/**
 * Apply dedup / mismatch logic to an already-field-filtered list of entries.
 *
 * Default (all=false, mismatch=false):
 *   Server entries always pass. A client entry is dropped when a server entry
 *   at the same [ns, line] produced the same msg (exact duplicate). Client
 *   entries at call sites with no server counterpart (onMount, event handlers)
 *   are kept. Client entries where msg differs from the server entry are kept —
 *   they surface as hydration mismatches alongside the server entry.
 *
 * all=true:
 *   No dedup. Every entry is returned as written.
 *
 * mismatch=true:
 *   Return only entries from call sites where BOTH envs exist AND msg differs.
 *   Entries from server-only or client-only call sites are suppressed.
 */
function applyDedup(
	entries: SerializedEntry[],
	all: boolean,
	mismatch: boolean
): SerializedEntry[] {
	if (all) return entries;

	// Build index: dedupKey → { serverMsgs, clientMsgs }
	const index = new Map<string, { serverMsgs: Set<string>; clientMsgs: Set<string> }>();
	for (const e of entries) {
		const k = dedupKey(e);
		if (!index.has(k)) index.set(k, { serverMsgs: new Set(), clientMsgs: new Set() });
		const slot = index.get(k)!;
		if (e.env === 'server') slot.serverMsgs.add(e.msg);
		else slot.clientMsgs.add(e.msg);
	}

	if (mismatch) {
		// Keep only entries from call sites where both envs exist and at least one
		// msg is present in one env but not the other (i.e. any difference exists).
		return entries.filter((e) => {
			const slot = index.get(dedupKey(e))!;
			if (slot.serverMsgs.size === 0 || slot.clientMsgs.size === 0) return false;
			// Check for any msg that exists on one side but not the other
			for (const m of slot.serverMsgs) if (!slot.clientMsgs.has(m)) return true;
			for (const m of slot.clientMsgs) if (!slot.serverMsgs.has(m)) return true;
			return false;
		});
	}

	// Default dedup: drop client entries that are exact duplicates of a server entry.
	return entries.filter((e) => {
		if (e.env !== 'client') return true;
		const slot = index.get(dedupKey(e));
		if (!slot || slot.serverMsgs.size === 0) return true; // no server counterpart — keep
		return !slot.serverMsgs.has(e.msg); // keep only if msg differs (mismatch)
	});
}

export default function ggFileSinkPlugin(options: GgFileSinkOptions = {}): Plugin {
	let logFile: string;
	let serverSideListener: ((entry: CapturedEntry) => void) | null = null;
	let ggModulePath = '';

	return {
		name: 'gg-file-sink',

		configResolved(config) {
			// Resolve the absolute path to gg.ts — works both in this repo (src/lib/gg.ts)
			// and in consumer projects where gg is in node_modules/@leftium/gg/src/lib/gg.ts.
			// We try both locations; whichever resolves to an existing file wins.
			const candidates = [
				path.resolve(config.root, 'src/lib/gg.ts'),
				path.resolve(config.root, 'node_modules/@leftium/gg/src/lib/gg.ts')
			];
			ggModulePath = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
		},

		transform(code, id, transformOptions) {
			if (id !== ggModulePath) return null;

			if (transformOptions?.ssr) {
				// SSR injection: write server-side entries directly to the log file.
				// Runs in Vite's SSR module runner (same Node.js process but separate module
				// instance from configureServer, so we can't share a listener — inject instead).
				// We pass appendFileSync + the log file path via globalThis so the injected
				// code has no imports of its own (avoids TLA / static import constraints).
				// Guarded by import.meta.env.DEV — tree-shaken in production builds.
				const ssrInjection = `
// gg-file-sink: server-side direct writer (injected by ggFileSinkPlugin)
if (import.meta.env.DEV && globalThis.__ggFileSink) {
	const { appendFileSync: __ggAppendFileSync, logFile: __ggLogFile } = globalThis.__ggFileSink;
	gg.addLogListener(function __ggFileSinkServerWriter(entry) {
		if (!__ggLogFile) return;
		const s = {
			ns: entry.namespace,
			msg: entry.message,
			ts: entry.timestamp,
			env: 'server',
			diff: entry.diff,
		};
		if (entry.level && entry.level !== 'debug') s.lvl = entry.level;
		if (entry.file) s.file = entry.file;
		if (entry.line !== undefined) s.line = entry.line;
		if (entry.src) s.src = entry.src;
		if (entry.tableData) s.table = entry.tableData;
		try { __ggAppendFileSync(__ggLogFile, JSON.stringify(s) + '\\n'); } catch {}
	});
}
`;
				return { code: code + ssrInjection, map: null };
			}

			// Browser injection: relay entries to Vite dev server via HMR WebSocket.
			// Runs once when the gg module is first loaded in the browser.
			// Guarded by import.meta.hot — Vite tree-shakes this in production builds.
			const injection = `
// gg-file-sink: client-side HMR sender (injected by ggFileSinkPlugin)
if (import.meta.hot) {
	const __ggFileSinkOrigin =
		typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
			? 'tauri'
			: 'browser';
	gg.addLogListener(function __ggFileSinkSender(entry) {
		if (!import.meta.hot) return;
		const s = {
			ns: entry.namespace,
			msg: entry.message,
			ts: entry.timestamp,
			env: 'client',
			origin: __ggFileSinkOrigin,
			diff: entry.diff,
		};
		if (entry.level && entry.level !== 'debug') s.lvl = entry.level;
		if (entry.file) s.file = entry.file;
		if (entry.line !== undefined) s.line = entry.line;
		if (entry.src) s.src = entry.src;
		if (entry.tableData) s.table = entry.tableData;
		import.meta.hot.send('gg:log', { entry: s });
	});
}
`;
			return { code: code + injection, map: null };
		},

		configureServer(server) {
			// Truncate/create log file once the actual port is known.
			// appendEntry() guards with `if (!logFile) return` for the brief window
			// before listening fires, so no entries are written to the wrong file.
			server.httpServer?.once('listening', () => {
				const addr = server.httpServer?.address();
				const port =
					addr && typeof addr === 'object' ? addr.port : (server.config.server.port ?? 5173);
				const dir = options.dir ? path.resolve(options.dir) : path.resolve(process.cwd(), '.gg');
				fs.mkdirSync(dir, { recursive: true });
				logFile = path.join(dir, `logs-${port}.jsonl`);
				fs.writeFileSync(logFile, '');
			});

			// Expose appendFileSync + logFile path via globalThis so the SSR-injected
			// listener (running in Vite's separate module runner context) can write to the
			// same file without needing its own fs import.
			(globalThis as Record<string, unknown>).__ggFileSink = {
				appendFileSync: fs.appendFileSync.bind(fs),
				get logFile() {
					return logFile;
				}
			};

			const appendEntry = (serialized: SerializedEntry) => {
				if (!logFile) return;
				fs.appendFileSync(logFile, JSON.stringify(serialized) + '\n');
			};

			// Client-side entries arrive via HMR custom event
			server.hot.on('gg:log', (data: { entry: SerializedEntry }) => {
				if (!data?.entry) return;
				const serialized: SerializedEntry = {
					...data.entry,
					env: 'client',
					origin: data.entry.origin ?? 'browser'
				};
				appendEntry(serialized);
			});

			// Server-side entries: register listener on the gg module directly
			serverSideListener = (entry: CapturedEntry) => {
				appendEntry(serializeEntry(entry, 'server'));
			};
			gg.addLogListener(serverSideListener);

			// Clean up on dev server close
			server.httpServer?.once('close', () => {
				if (serverSideListener) {
					gg.removeLogListener(serverSideListener);
					serverSideListener = null;
				}
				delete (globalThis as Record<string, unknown>).__ggFileSink;
			});

			// /__gg/ index — JSON status for agents and developers
			server.middlewares.use('/__gg', (req, res, next) => {
				const pathname = new URL(req.url || '/', 'http://x').pathname;
				// Only handle exact /__gg or /__gg/ — let other /__gg/* routes fall through
				if (pathname !== '' && pathname !== '/') return next();
				if (req.method?.toUpperCase() !== 'GET') return next();

				let entries = 0;
				try {
					const content = fs.readFileSync(logFile, 'utf-8');
					entries = content.split('\n').filter((l) => l.trim()).length;
				} catch {
					// file not yet created — leave entries at 0
				}

				const port = (() => {
					const addr = server.httpServer?.address();
					return addr && typeof addr === 'object' ? addr.port : (server.config.server.port ?? 5173);
				})();

				const body = JSON.stringify(
					{
						plugin: 'gg-file-sink',
						logFile: `.gg/logs-${port}.jsonl`,
						entries,
						endpoints: {
							'GET /__gg/logs':
								'read deduplicated JSONL entries (?filter=, ?since=, ?env=, ?origin=, ?all, ?mismatch)',
							'DELETE /__gg/logs': 'truncate log file',
							'GET /__gg/project-root': 'project root path'
						}
					},
					null,
					2
				);

				res.statusCode = 200;
				res.setHeader('Content-Type', 'application/json; charset=utf-8');
				res.end(body);
			});

			// /__gg/logs middleware
			server.middlewares.use('/__gg/logs', (req, res) => {
				const method = req.method?.toUpperCase();

				// HEAD: used by runGgDiagnostics() to detect plugin presence
				if (method === 'HEAD') {
					res.statusCode = 200;
					res.end();
					return;
				}

				if (method === 'DELETE') {
					try {
						fs.writeFileSync(logFile, '');
						res.statusCode = 204;
						res.end();
					} catch (err) {
						res.statusCode = 500;
						res.end(String(err));
					}
					return;
				}

				if (method === 'GET') {
					try {
						const params = new URL(req.url || '/', 'http://x').searchParams;
						const all = params.has('all');
						const mismatch = params.has('mismatch');

						res.setHeader('Content-Type', 'text/plain; charset=utf-8');

						const raw = fs.readFileSync(logFile, 'utf-8');
						const lines = raw.split('\n').filter((l) => l.trim());

						// Pre-dedup filters: namespace glob and timestamp (symmetric — don't affect cross-env index)
						const preFiltered = lines.filter((l) => filterLinePreDedup(l, params));

						// Parse surviving lines for dedup/mismatch pass
						const entries = preFiltered.flatMap((l) => {
							try {
								return [JSON.parse(l) as SerializedEntry];
							} catch {
								return [];
							}
						});

						// Apply dedup / mismatch logic (default: dedup on)
						const deduped = applyDedup(entries, all, mismatch);

						// Post-dedup filters: env and origin (applied after so cross-env index is intact)
						const result = deduped.filter((e) => filterEntryPostDedup(e, params));

						res.statusCode = 200;
						res.end(result.map((e) => JSON.stringify(e)).join('\n') + (result.length ? '\n' : ''));
					} catch (err) {
						res.statusCode = 500;
						res.end(String(err));
					}
					return;
				}

				res.statusCode = 405;
				res.setHeader('Allow', 'GET, HEAD, DELETE');
				res.end('Method Not Allowed');
			});
		}
	};
}
