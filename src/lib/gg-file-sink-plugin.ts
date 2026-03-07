import type { Plugin } from 'vite';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
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

function filterLine(line: string, params: URLSearchParams): boolean {
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

	const env = params.get('env');
	if (env && entry.env !== env) return false;

	const origin = params.get('origin');
	if (origin && entry.origin !== origin) return false;

	return true;
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
		import.meta.hot.send('gg:log', { entry: s, origin: __ggFileSinkOrigin });
	});
}
`;
			return { code: code + injection, map: null };
		},

		configureServer(server) {
			// Resolve port and log file path
			const resolveLogFile = () => {
				const port = server.config.server.port ?? 5173;
				const dir = options.dir ? path.resolve(options.dir) : path.resolve(process.cwd(), '.gg');
				fs.mkdirSync(dir, { recursive: true });
				return path.join(dir, `logs-${port}.jsonl`);
			};

			// Truncate/create log file on server start
			// Use httpServer listen event to get the actual resolved port
			server.httpServer?.once('listening', () => {
				const addr = server.httpServer?.address();
				const port =
					addr && typeof addr === 'object' ? addr.port : (server.config.server.port ?? 5173);
				const dir = options.dir ? path.resolve(options.dir) : path.resolve(process.cwd(), '.gg');
				fs.mkdirSync(dir, { recursive: true });
				logFile = path.join(dir, `logs-${port}.jsonl`);
				fs.writeFileSync(logFile, '');
			});

			// Fallback: resolve before listen if httpServer not available yet
			logFile = resolveLogFile();
			fs.writeFileSync(logFile, '');

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
			server.hot.on('gg:log', (data: { entry: SerializedEntry; origin: 'tauri' | 'browser' }) => {
				if (!data?.entry) return;
				const serialized: SerializedEntry = {
					...data.entry,
					env: 'client',
					origin: data.origin ?? 'browser'
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
				const pathname = url.parse(req.url || '').pathname || '';
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
							'GET /__gg/logs': 'read JSONL log entries (?filter=, ?since=, ?env=, ?origin=)',
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
						const params = new URLSearchParams(url.parse(req.url || '').query || '');
						const hasFilters =
							params.has('filter') ||
							params.has('since') ||
							params.has('env') ||
							params.has('origin');

						res.setHeader('Content-Type', 'text/plain; charset=utf-8');

						if (!hasFilters) {
							// No filters — stream the whole file
							const content = fs.readFileSync(logFile, 'utf-8');
							res.statusCode = 200;
							res.end(content);
						} else {
							const raw = fs.readFileSync(logFile, 'utf-8');
							const lines = raw.split('\n').filter((l) => l.trim());
							const filtered = lines.filter((l) => filterLine(l, params));
							res.statusCode = 200;
							res.end(filtered.join('\n') + (filtered.length ? '\n' : ''));
						}
					} catch (err) {
						res.statusCode = 500;
						res.end(String(err));
					}
					return;
				}

				res.statusCode = 405;
				res.setHeader('Allow', 'GET, DELETE');
				res.end('Method Not Allowed');
			});
		}
	};
}
