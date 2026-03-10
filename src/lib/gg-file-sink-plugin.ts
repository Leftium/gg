import * as fs from 'fs';
import * as path from 'path';
import type { Plugin } from 'vite';
import type { CapturedEntry } from './eruda/types.js';
import { gg } from './gg.js';
import { matchesPattern } from './pattern.js';

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

/** SerializedEntry with optional repeat-count for HTTP output. */
interface OutputEntry extends SerializedEntry {
	count?: number;
}

/**
 * Serialize a CapturedEntry for writing to the JSONL log file.
 *
 * Used by:
 * - configureServer listener (plugin's own gg instance)
 * - globalThis.__ggFileSink.write() (SSR gg instances via self-registration)
 * - Virtual module sender mirrors this schema as inline JS (search for `__ggFileSinkSender`)
 */
function serializeEntry(
	entry: CapturedEntry,
	env: 'client' | 'server',
	origin?: 'tauri' | 'browser',
): SerializedEntry {
	const out: SerializedEntry = {
		ns: entry.namespace,
		msg: entry.message,
		ts: entry.timestamp,
		env,
		diff: entry.diff,
	};
	if (entry.level && entry.level !== 'debug') out.lvl = entry.level;
	if (origin) out.origin = origin;
	if (entry.file) out.file = entry.file;
	if (entry.line !== undefined) out.line = entry.line;
	if (entry.src) out.src = entry.src;
	if (entry.tableData) out.table = entry.tableData;
	return out;
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
function filterEntryPostDedup(
	entry: SerializedEntry,
	params: URLSearchParams,
): boolean {
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
	mismatch: boolean,
): SerializedEntry[] {
	if (all) return entries;

	// Build index: dedupKey → { serverMsgs, clientMsgs }
	const index = new Map<
		string,
		{ serverMsgs: Set<string>; clientMsgs: Set<string> }
	>();
	for (const e of entries) {
		const k = dedupKey(e);
		if (!index.has(k))
			index.set(k, { serverMsgs: new Set(), clientMsgs: new Set() });
		const slot = index.get(k)!;
		if (e.env === 'server') slot.serverMsgs.add(e.msg);
		else slot.clientMsgs.add(e.msg);
	}

	if (mismatch) {
		// Keep only entries from call sites where both envs exist and at least one
		// msg is present in one env but not the other (i.e. any difference exists).
		return entries.filter((e) => {
			const slot = index.get(dedupKey(e))!;
			if (slot.serverMsgs.size === 0 || slot.clientMsgs.size === 0)
				return false;
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

/**
 * Collapse consecutive entries with the same ns+msg into a single entry with
 * a `count` field. Mirrors the Chrome DevTools repeat-counter behaviour.
 *
 * Only consecutive runs are collapsed — intentional: an entry appearing again
 * after different messages is a new event and should be shown separately.
 *
 * The `ts` and `diff` of the *first* occurrence are kept; `count` is omitted
 * when it is 1 (no repetition) so the schema stays clean for non-repeated entries.
 */
function collapseRepeats(entries: SerializedEntry[]): OutputEntry[] {
	const out: OutputEntry[] = [];
	for (const e of entries) {
		const prev = out.at(-1);
		if (prev && prev.ns === e.ns && prev.msg === e.msg) {
			prev.count = (prev.count ?? 1) + 1;
		} else {
			out.push({ ...e });
		}
	}
	return out;
}

/**
 * Virtual module ID for the browser-side file sink sender.
 *
 * Virtual modules go through Vite's normal transform pipeline (NOT pre-bundled
 * by esbuild), so `import.meta.hot` is available. This solves the fundamental
 * problem: code inside pre-bundled deps (like gg.js) cannot use import.meta.hot
 * because esbuild evaluates `typeof import.meta.hot` as "undefined" during
 * dep optimization and tree-shakes the entire block.
 *
 * The virtual module is imported via a <script type="module"> tag injected by
 * the `transformIndexHtml` hook below.
 */
const VIRTUAL_MODULE_ID = 'virtual:gg-file-sink-sender';
const RESOLVED_VIRTUAL_MODULE_ID = '\0' + VIRTUAL_MODULE_ID;

export default function ggFileSinkPlugin(
	options: GgFileSinkOptions = {},
): Plugin {
	let logFile: string;
	let serverSideListener: ((entry: CapturedEntry) => void) | null = null;

	return {
		name: 'gg-file-sink',

		// Virtual module: resolve and load the browser-side HMR sender.
		resolveId(id) {
			if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID;
		},

		load(id) {
			if (id === RESOLVED_VIRTUAL_MODULE_ID) {
				// This code runs through Vite's normal transform pipeline (not
				// pre-bundled), so import.meta.hot is properly available.
				//
				// Uses a dual strategy for sending log entries to the dev server:
				// 1. import.meta.hot.send() via HMR WebSocket (fast, no HTTP overhead)
				// 2. fetch() POST to /__gg/logs as fallback (works even if HMR is unavailable)
				//
				// NOTE: this string mirrors serializeEntry() above — keep in sync.
				return `
import { gg } from '@leftium/gg';

const origin =
	typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
		? 'tauri'
		: 'browser';

// Batch entries and flush via fetch POST — works regardless of HMR state.
let __ggPendingEntries = [];
let __ggFlushTimer = null;
function __ggFlushEntries() {
	__ggFlushTimer = null;
	if (__ggPendingEntries.length === 0) return;
	const batch = __ggPendingEntries;
	__ggPendingEntries = [];
	const body = batch.map(e => JSON.stringify(e)).join('\\n');
	fetch('/__gg/logs', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
}

gg.addLogListener(function __ggFileSinkSender(entry) {
	const s = {
		ns: entry.namespace,
		msg: entry.message,
		ts: entry.timestamp,
		env: 'client',
		origin,
		diff: entry.diff,
	};
	if (entry.level && entry.level !== 'debug') s.lvl = entry.level;
	if (entry.file) s.file = entry.file;
	if (entry.line !== undefined) s.line = entry.line;
	if (entry.src) s.src = entry.src;
	if (entry.tableData) s.table = entry.tableData;

	// Try HMR first (lowest latency), fall back to batched fetch
	if (import.meta.hot) {
		import.meta.hot.send('gg:log', { entry: s });
	} else {
		__ggPendingEntries.push(s);
		if (!__ggFlushTimer) __ggFlushTimer = setTimeout(__ggFlushEntries, 100);
	}
});
`;
			}
		},

		// Inject the virtual module into the HTML page so it runs in the browser.
		// Uses both transformIndexHtml (plain Vite apps) and a response-intercepting
		// middleware (SvelteKit and other frameworks that bypass Vite's HTML pipeline).
		transformIndexHtml() {
			return [
				{
					tag: 'script',
					attrs: { type: 'module', src: `/@id/${VIRTUAL_MODULE_ID}` },
					injectTo: 'head',
				},
			];
		},

		configureServer(server) {
			// Truncate/create log file once the actual port is known.
			// appendEntry() guards with `if (!logFile) return` for the brief window
			// before listening fires, so no entries are written to the wrong file.
			server.httpServer?.once('listening', () => {
				const addr = server.httpServer?.address();
				const port =
					addr && typeof addr === 'object'
						? addr.port
						: (server.config.server.port ?? 5173);
				const dir = options.dir
					? path.resolve(options.dir)
					: path.resolve(process.cwd(), '.gg');
				fs.mkdirSync(dir, { recursive: true });
				logFile = path.join(dir, `logs-${port}.jsonl`);
				fs.writeFileSync(logFile, '');
			});

			const appendEntry = (serialized: SerializedEntry) => {
				if (!logFile) return;
				fs.appendFileSync(logFile, JSON.stringify(serialized) + '\n');
			};

			// Expose a write() function via globalThis so ANY gg module instance
			// (SSR, pre-bundled, monorepo-hoisted) can self-register a listener
			// that writes to the log file. This replaces the broken transform hook.
			(globalThis as Record<string, unknown>).__ggFileSink = {
				write(
					entry: CapturedEntry,
					env: 'client' | 'server',
					origin?: 'tauri' | 'browser',
				) {
					appendEntry(serializeEntry(entry, env, origin));
				},
			};

			// Client-side entries arrive via HMR custom event
			server.hot.on('gg:log', (data: { entry: SerializedEntry }) => {
				if (!data?.entry) return;
				const serialized: SerializedEntry = {
					...data.entry,
					env: 'client',
					origin: data.entry.origin ?? 'browser',
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

				// /__gg/stack — dump Connect middleware stack for debugging
				if (pathname === '/stack') {
					const stack = (
						server.middlewares as unknown as {
							stack: Array<{ route: string; handle: { name?: string } }>;
						}
					).stack;
					const routes = stack.map((layer, i) => ({
						i,
						route: layer.route,
						name: layer.handle?.name || '(anonymous)',
					}));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(routes, null, 2));
					return;
				}

				// /__gg/sender — redirect to the virtual module URL so Vite's
				// normal transform pipeline handles it (including HMR injection).
				// Direct transformRequest() fails in consumer apps because the
				// module graph hasn't loaded the virtual module yet at request time.
				if (pathname === '/sender') {
					res.writeHead(302, {
						Location: `/@id/${VIRTUAL_MODULE_ID}`,
					});
					res.end();
					return;
				}

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
					return addr && typeof addr === 'object'
						? addr.port
						: (server.config.server.port ?? 5173);
				})();

				const body = JSON.stringify(
					{
						plugin: 'gg-file-sink',
						logFile: `.gg/logs-${port}.jsonl`,
						entries,
						endpoints: {
							'GET /__gg/logs':
								'read deduplicated JSONL entries (?filter=, ?since=, ?env=, ?origin=, ?all, ?mismatch, ?raw)',
							'DELETE /__gg/logs': 'truncate log file',
							'GET /__gg/project-root': 'project root path',
						},
					},
					null,
					2,
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

				// POST: receive client-side log entries via fetch (fallback for HMR)
				if (method === 'POST') {
					let body = '';
					req.on('data', (chunk: Buffer) => {
						body += chunk.toString();
					});
					req.on('end', () => {
						try {
							const lines = body.split('\n').filter((l: string) => l.trim());
							for (const line of lines) {
								const entry = JSON.parse(line) as SerializedEntry;
								entry.env = 'client';
								entry.origin = entry.origin ?? 'browser';
								appendEntry(entry);
							}
							res.statusCode = 204;
							res.end();
						} catch (err) {
							res.statusCode = 400;
							res.end(String(err));
						}
					});
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
						// ?raw disables consecutive-repeat collapsing (count field)
						const noCollapse = params.has('raw');

						res.setHeader('Content-Type', 'text/plain; charset=utf-8');

						const fileContent = fs.readFileSync(logFile, 'utf-8');
						const lines = fileContent
							.split('\n')
							.filter((l: string) => l.trim());

						// Pre-dedup filters: namespace glob and timestamp (symmetric — don't affect cross-env index)
						const preFiltered = lines.filter((l) =>
							filterLinePreDedup(l, params),
						);

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
						const postFiltered = deduped.filter((e) =>
							filterEntryPostDedup(e, params),
						);

						// Collapse consecutive repeated messages (count field), unless ?raw
						const result = noCollapse
							? postFiltered
							: collapseRepeats(postFiltered);

						res.statusCode = 200;
						res.end(
							result.map((e) => JSON.stringify(e)).join('\n') +
								(result.length ? '\n' : ''),
						);
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
		},
	};
}
