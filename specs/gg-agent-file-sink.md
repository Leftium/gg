# gg Agent File Sink: JSONL Log File via Vite HMR

**Date**: 2026-03-08
**Status**: Implemented (Phase 1 + Phase 2 complete)
**Author**: AI-assisted

## Overview

Capture all `gg()` log entries -- both client-side (browser) and server-side (SSR, API routes) -- to a local JSONL file (`.gg/logs-{port}.jsonl`). Browser entries relay over Vite's existing HMR WebSocket; server-side entries write directly to disk in the same Node.js process. This gives coding agents (and any file-reading tool) direct access to runtime log output without clipboard, browser automation, or server-side application routes.

## Motivation

### Current State

The `gg()` ring buffer and Eruda plugin UI work well for human developers:

```
gg() call → _onLog hook → LogBuffer (browser memory) → Eruda panel → Copy button → Clipboard → Paste into agent prompt
```

This requires the developer to:

1. Open the Eruda panel
2. Optionally configure a filter
3. Click Copy
4. Switch to the agent prompt and paste

### Problems

1. **Agents cannot observe browser runtime output.** Coding agents have filesystem and HTTP access but no browser DevTools connection. `console.log` output is invisible to them.
2. **Manual clipboard relay.** Every round trip through the agent requires the developer to manually copy and paste log output, breaking flow.
3. **No programmatic query.** Agents cannot filter or search log entries -- they get whatever the developer copies.
4. **SPA constraint.** Apps like Whispering are pure SPAs with no application server. Adding server routes for log retrieval isn't an option. But the Vite dev server is always running during development.

### Desired State

```
CLIENT:  gg() → _onLog → HMR WebSocket → Vite plugin ──► .gg/logs-5173.jsonl
SERVER:  gg() → _onLog → direct fs.appendFile ──────────►       (same file)
                                                                     ↑
                                                      Agent reads/greps this file
```

The developer still triggers the UI action (page load, button click, etc.), but log collection is fully automatic. The agent reads the JSONL file directly -- no clipboard, no paste, no browser needed. Both client-side and server-side `gg()` calls end up in the same file, distinguished by the `env` field.

## Research Findings

### Vite HMR Custom Events

Vite's HMR WebSocket supports custom event types in both directions:

| Direction        | Browser API                           | Server API                       |
| ---------------- | ------------------------------------- | -------------------------------- |
| Browser → Server | `import.meta.hot.send(event, data)`   | `server.hot.on(event, callback)` |
| Server → Browser | `import.meta.hot.on(event, callback)` | `server.hot.send(event, data)`   |

**Key finding**: The WebSocket connection is already open for HMR. Custom messages add zero connection overhead. Payload size is the only cost.

**Implication**: Browser-to-server transport is essentially free infrastructure. No new connections, no polling, no middleware endpoints.

### File Write Performance

| Operation                   | Typical latency | Notes                               |
| --------------------------- | --------------- | ----------------------------------- |
| `fs.appendFile` (async)     | 0.01-0.1ms      | Non-blocking, suitable for hot path |
| `fs.appendFileSync`         | 0.05-0.5ms      | Blocks event loop, avoid            |
| Batched write (100 entries) | ~0.1ms          | Amortizes syscall overhead          |

**Key finding**: At typical dev logging volumes (1-50 entries/sec), async `appendFile` is negligible. Even at 100 entries/sec, the file I/O cost is unmeasurable against normal Vite dev server work.

**Implication**: No batching needed on the server side. Append each entry as it arrives. Batching on the browser side (before sending over HMR) is optional but could reduce WebSocket message count for high-volume logging.

### JSONL vs SQLite

| Dimension          | JSONL                                        | SQLite                                          |
| ------------------ | -------------------------------------------- | ----------------------------------------------- |
| Agent readability  | `grep` / `cat` -- universally available      | Requires `sqlite3` CLI or library               |
| Structured queries | Manual (jq, custom parsing)                  | Native (time ranges, aggregation, COUNT)        |
| Append performance | `fs.appendFile` -- trivial                   | Transaction overhead per write                  |
| Concurrent access  | Safe for small appends (< 4KB, POSIX atomic) | Built-in locking, but write contention possible |
| File inspection    | Human-readable in any editor                 | Binary format, requires tooling                 |
| Corruption risk    | One bad line, rest is fine                   | Corruption can affect entire DB                 |

**Key finding**: Every coding agent has `grep` and `cat`. Not every agent has `sqlite3`. For the primary use case -- "show me logs matching this pattern" -- `grep` on JSONL is equivalent to a SQL query and has zero dependencies.

**Implication**: JSONL is the right default. If structured queries become important later, a JSONL file can be loaded into SQLite after the fact. The reverse isn't true -- SQLite isn't grep-friendly.

### JSONL Format Details

One JSON object per line. Advantages for agents:

- `grep` works (no multi-line parsing needed)
- Append-only (no need to parse/rewrite the file)
- Streaming-friendly (tail -f equivalent)
- Each line is independently parseable (partial file reads work)

## Design Decisions

| Decision                | Choice                                                | Rationale                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport               | Vite HMR custom events                                | WebSocket already open, zero additional infra. gg already ships Vite plugins.                                                                                                             |
| File format             | JSONL over SQLite                                     | Every agent has `grep`; not every agent has `sqlite3`. JSONL is append-only, human-readable, corruption-tolerant.                                                                         |
| File location           | `.gg/logs-{port}.jsonl`                               | Port-scoped to isolate multiple dev servers. Grouped under `.gg/` for easy gitignore. Discoverable via `ls .gg/logs-*.jsonl`.                                                             |
| Truncation              | Auto on server start + agent-initiated clear via HTTP | Auto-truncate prevents unbounded growth. Agent clear (`DELETE /__gg/logs`) gives precise control -- agent clears right before triggering an action, then reads only the relevant entries. |
| Browser-side batching   | Optional, deferred                                    | Simplicity first. One HMR message per `gg()` call. Batch later if profiling shows need.                                                                                                   |
| Filtering               | Agent-side (grep the file)                            | No server-side filter config needed. JSONL fields are greppable. Agent uses its own tools.                                                                                                |
| Serialization           | Subset of CapturedEntry fields                        | Skip `args` (may contain non-serializable objects). Include namespace, message, timestamp, level, env, origin, file, line, src, tableData.                                                |
| Client origin detection | `window.__TAURI_INTERNALS__` check                    | Tauri injects this global in its webview. Detected once on init, stamped on every entry. Distinguishes Tauri webview from browser tab when both connect to the same Vite dev server.      |
| Activation              | Dev-only, opt-in via plugin option                    | No file I/O in production. Explicit opt-in prevents surprise disk writes.                                                                                                                 |
| Production behavior     | Automatic no-op, zero bundle cost                     | `import.meta.hot` is `undefined` in prod builds -- Vite dead-code-eliminates the client sender. `configureServer` only runs in dev.                                                       |
| File writes             | `appendFileSync` (not async)                          | Preserves write order under high-volume bursts. At dev logging volumes the sync overhead is negligible.                                                                                   |
| SSR server-side capture | Transform injection + `globalThis.__ggFileSink`       | Vite's SSR module runner is a separate module instance from `configureServer` — a direct listener on the plugin's `gg` import doesn't see SSR calls. `globalThis` bridges the gap.        |
| `earlyLogBuffer`        | Persistent (never cleared), capped at 2000            | Multiple listeners register at different times (file-sink at module load, Eruda at component mount). Every new listener gets a full replay; clearing on first registration broke Eruda.   |

## Architecture

```
BROWSER (client)                          VITE DEV SERVER (Node.js)
┌────────────────────────┐                ┌──────────────────────────────┐
│                        │                │                              │
│  gg('hello').warn()    │                │  ggFileSinkPlugin()          │
│       │                │                │       │                      │
│       ▼                │                │       ▼                      │
│  _onLogCallback(entry) │                │  server.hot.on('gg:log',     │
│       │                │   WebSocket    │    (entry) => {              │
│       ├───────────────────────────────► │      append(entry,           │
│       │  hot.send(     │  'gg:log'      │        env: 'client')        │
│       │   'gg:log',    │                │    })                        │
│       │    serialized) │                │                              │
│       │                │                │  SERVER-SIDE gg() (SSR,      │
│       ▼                │                │  load functions, API routes) │
│  LogBuffer.push(entry) │                │  [Vite SSR module runner —   │
│  (existing flow)       │                │   separate module instance]  │
│                        │                │       │                      │
│  import.meta.hot is    │                │       ▼                      │
│  undefined in prod     │                │  listener injected into      │
│  → entire sender is    │                │  gg.ts via transform hook    │
│    tree-shaken away    │                │  (SSR only, DEV only):       │
│                        │                │    reads globalThis          │
│                        │                │      .__ggFileSink.logFile   │
│                        │                │    appendFileSync(entry,     │
│                        │                │      env: 'server')          │
│                        │                │       │  (direct, no HMR)    │
│                        │                │       │                      │
│                        │                │       ▼                      │
│                        │                │  fs.appendFileSync(          │
│                        │                │    `.gg/logs-${port}.jsonl`, │
│                        │                │    JSON.stringify(entry)     │
│                        │                │    + '\n'                    │
│                        │                │  )                           │
│                        │                │                              │
│                        │                │  configureServer:            │
│                        │                │    resolve port              │
│                        │                │    truncate on start         │
│                        │                │    set globalThis.__ggFileSink│
│                        │                │                              │
│                        │                │  middleware:                 │
│                        │                │    DELETE /__gg/logs → clear │
│                        │                │    GET /__gg/logs → read     │
│                        │                │                              │
│                        │                │  configureServer only runs   │
│                        │                │  in dev → no-op in prod      │
└────────────────────────┘                └──────────────────────────────┘
                                                     │
                                                     ▼
                                          .gg/logs-5173.jsonl
                                          ┌──────────────────────────────────────┐
                                          │ {"env":"server","ns":"..."}          │
                                          │ {"env":"client","origin":"tauri"}    │
                                          │ {"env":"client","origin":"browser"}  │
                                          │ {"env":"server","ns":"..."}          │
                                          └──────────────────────────────────────┘
                                                     ↑
                                          Agent reads file directly
                                          or via GET /__gg/logs
                                          Filter by env/origin:
                                            grep '"origin":"tauri"' ...
                                            GET /__gg/logs?env=server
                                            GET /__gg/logs?origin=browser
```

### Serialized Entry Format

Each JSONL line contains a subset of `CapturedEntry` fields, chosen for agent utility and safe serialization:

```jsonl
{"ns":"gg:routes/+page.svelte@handleClick","msg":"Processing item: {id: 42}","ts":1741234567890,"lvl":"warn","env":"client","origin":"tauri","file":"src/routes/+page.svelte","line":42,"src":"item","diff":12}
{"ns":"gg:routes/+page.svelte@handleClick","msg":"Processing item: {id: 42}","ts":1741234567920,"env":"client","origin":"browser","file":"src/routes/+page.svelte","line":42,"src":"item","diff":30}
{"ns":"gg:routes/+page.server.ts@load","msg":"Fetching user data","ts":1741234567885,"env":"server","file":"src/routes/+page.server.ts","line":18,"diff":0}
```

| Field    | Source      | Description                                                                                              |
| -------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `ns`     | `namespace` | Namespace string (greppable)                                                                             |
| `msg`    | `message`   | Formatted message string                                                                                 |
| `ts`     | `timestamp` | Unix epoch ms                                                                                            |
| `lvl`    | `level`     | `"debug"` \| `"info"` \| `"warn"` \| `"error"` (omitted if debug)                                        |
| `env`    | (injected)  | `"client"` or `"server"` -- which runtime produced this entry                                            |
| `origin` | (injected)  | `"tauri"` \| `"browser"` (client only) -- which client produced this entry                               |
| `file`   | `file`      | Source file path                                                                                         |
| `line`   | `line`      | Source line number                                                                                       |
| `src`    | `src`       | Source expression text (icecream-style)                                                                  |
| `diff`   | `diff`      | Ms since previous log in same namespace                                                                  |
| `table`  | `tableData` | Structured table data `{ keys: string[], rows: Record<string,unknown>[] }` (omitted if not a table logg) |

The `env` field is added by the transport layer, not by `gg()` itself. The client-side HMR sender stamps `"client"`; the server-side direct writer stamps `"server"`. This lets agents distinguish SSR load function logs from hydrated component logs, even when both target the same source file.

The `origin` field distinguishes which client produced the entry. Detected client-side via `window.__TAURI_INTERNALS__` -- if present, `"tauri"`; otherwise `"browser"`. This is important because Tauri apps (`bun tauri dev`) open the Vite dev server in a Tauri webview by default, and the developer or agent may also open the same URL in a browser. Both connect to the same Vite HMR WebSocket and both produce `env: "client"` entries. Without `origin`, these are indistinguishable. The `origin` field is omitted for `env: "server"` entries (server-side code has no client context).

Agents can filter by environment and origin:

- `grep '"env":"server"' .gg/logs-5173.jsonl` -- server-side only
- `grep '"origin":"tauri"' .gg/logs-5173.jsonl` -- Tauri webview only
- `GET /__gg/logs?origin=browser` -- browser tab only

### Querying with `jq`

`grep` works for quick pattern matching, but `jq` is the preferred tool for structured JSONL queries. It gives precise field-level filtering without false matches (e.g., `grep '"server"'` would match a message string containing the word "server", while `jq 'select(.env == "server")'` is exact).

`jq` is pre-installed on macOS and most Linux distributions. Agents should prefer `jq` when available, fall back to `grep` for environments where `jq` is missing.

**Basic filtering:**

In SSR apps, component `gg()` calls appear in the file twice — once as `env:"server"` (first render) and once as `env:"client"` (hydration). Pick the side you need, or use the dedup query for a full picture without duplicates.

```bash
# Check the env split first (useful in SSR apps)
jq -s 'group_by(.env) | map({env: .[0].env, count: length})' .gg/logs-5173.jsonl

# Client-side only (component behavior, user interactions)
jq 'select(.env == "client")' .gg/logs-5173.jsonl

# Server-side only (load functions, API routes, auth)
jq 'select(.env == "server")' .gg/logs-5173.jsonl

# Full picture without SSR duplicates — server entries + client-only entries (e.g. onMount)
jq -s '
  (map(select(.env == "server")) | map([.ns, .line] | join(":")) | unique) as $server_keys |
  map(select(
    .env == "server" or
    (([.ns, .line] | join(":")) | IN($server_keys[]) | not)
  ))
' .gg/logs-5173.jsonl

# All entries from a specific namespace
jq 'select(.ns | startswith("gg:routes/+page"))' .gg/logs-5173.jsonl

# Errors only
jq 'select(.lvl == "error")' .gg/logs-5173.jsonl

# Client entries from the Tauri webview
jq 'select(.env == "client" and .origin == "tauri")' .gg/logs-5173.jsonl
```

**Extracting specific fields (reduce noise):**

```bash
# Just timestamps and messages
jq '{ts: .ts, msg: .msg}' .gg/logs-5173.jsonl

# Namespace, message, and source location
jq '{ns: .ns, msg: .msg, file: .file, line: .line}' .gg/logs-5173.jsonl

# Messages only, as plain text (one per line, no JSON wrapping)
jq -r '.msg' .gg/logs-5173.jsonl
```

**Time-range queries:**

```bash
# Entries from the last 5 seconds (ts is Unix epoch ms)
jq "select(.ts > (now * 1000 - 5000))" .gg/logs-5173.jsonl

# Entries after a specific timestamp
jq 'select(.ts > 1741234567890)' .gg/logs-5173.jsonl
```

**Counting and aggregation:**

```bash
# Count entries by env
jq -s 'group_by(.env) | map({env: .[0].env, count: length})' .gg/logs-5173.jsonl

# Count entries by namespace
jq -s 'group_by(.ns) | map({ns: .[0].ns, count: length}) | sort_by(-.count)' .gg/logs-5173.jsonl
```

**SSR hydration mismatches:**

```bash
# Call sites where server and client produced different values.
# Only flags entries where BOTH envs exist for the same [ns, line] AND msg differs.
# Call sites that only run server-side (auth) or client-side (onMount) are ignored.
jq -s '
  group_by([.ns, .line]) |
  map(select(map(.env) | (contains(["server"]) and contains(["client"])))) |
  map({
    ns: .[0].ns, line: .[0].line,
    server: (map(select(.env=="server")) | .[0].msg),
    client: (map(select(.env=="client")) | .[0].msg)
  }) |
  map(select(.server != .client))
' .gg/logs-5173.jsonl
```

**Combining with other tools:**

```bash
# Last 20 entries, pretty-printed
tail -20 .gg/logs-5173.jsonl | jq .

# Pipe HTTP API response through jq
curl -s http://localhost:5173/__gg/logs | jq 'select(.lvl == "error")'
```

**`grep` vs `jq` trade-offs:**

| Dimension        | `grep`                                            | `jq`                                                          |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| Availability     | Universal                                         | Pre-installed on macOS/most Linux; may need install elsewhere |
| Speed            | Faster for large files (no JSON parsing)          | Slightly slower but negligible at dev log volumes             |
| Precision        | Substring match (may false-match message content) | Exact field-level filtering                                   |
| Field extraction | Not possible (returns whole lines)                | Select, reshape, format individual fields                     |
| Aggregation      | Not possible                                      | `group_by`, `length`, `sort_by`, etc.                         |
| Learning curve   | Minimal                                           | Moderate (but agents already know `jq` syntax)                |

**Recommendation for agents**: Use `jq` as the default querying tool. Fall back to `grep` if `jq` is unavailable or for quick single-pattern searches where precision doesn't matter.

**Excluded**: `args` (may contain circular refs, DOM nodes, non-serializable objects), `color` (cosmetic), `col` (rarely useful), `stack` (large, could be opt-in).

### Hook Points: Client and Server

The file sink captures entries from two separate runtime environments via different transport mechanisms, both writing to the same JSONL file.

#### Client-Side (Browser → HMR → File)

```
STEP 1: Plugin injects client-side HMR sender
──────────────────────────────────────────────
The gg-file-sink Vite plugin uses Vite's virtual module or transform
to inject code that registers an additional _onLog listener.
This runs alongside the existing Eruda hook -- both receive entries.

STEP 2: Browser serializes and sends
─────────────────────────────────────
On each gg() call, the injected code serializes the CapturedEntry
(stripping non-serializable fields), stamps env: 'client' and
origin: 'tauri' | 'browser' (detected once on init via
window.__TAURI_INTERNALS__), and calls
import.meta.hot.send('gg:log', data).

STEP 3: Vite plugin receives and writes
────────────────────────────────────────
The plugin's configureServer hook registers server.hot.on('gg:log', ...)
which appends the JSON line to .gg/logs-{port}.jsonl.
```

#### Server-Side (Transform Injection + globalThis Bridge)

```
STEP 1: configureServer sets globalThis.__ggFileSink
─────────────────────────────────────────────────────
When the Vite dev server starts, configureServer resolves the log
file path and sets:
  globalThis.__ggFileSink = {
    appendFileSync: fs.appendFileSync,
    get logFile() { return logFile; }   // live getter — updates after port resolves
  }

STEP 2: Plugin injects server-side writer into gg.ts (SSR transform)
──────────────────────────────────────────────────────────────────────
The transform hook detects SSR builds (transformOptions.ssr === true)
and appends a listener registration to gg.ts:

  if (import.meta.env.DEV && globalThis.__ggFileSink) {
    const { appendFileSync, logFile } = globalThis.__ggFileSink;
    gg.addLogListener(function __ggFileSinkServerWriter(entry) {
      // serialize and appendFileSync to logFile
    });
  }

This runs inside Vite's SSR module runner — the same context as
SvelteKit load functions, API routes, and SSR components.

STEP 3: Direct append
─────────────────────
On each server-side gg() call, the injected listener serializes
the CapturedEntry, stamps env: 'server', and calls
fs.appendFileSync on the same .gg/logs-{port}.jsonl file.
Guarded by import.meta.env.DEV — tree-shaken in production.
```

**Why not a direct configureServer listener?** Vite's SSR module runner is a separate module instance from the plugin's Node.js context. A listener registered on the plugin's imported `gg` object never fires for SSR `gg()` calls — they're on a different object. The `globalThis` bridge and transform injection solve this: the injected code runs inside the SSR context and reads the file path from `globalThis`, which is shared across all Node.js contexts in the same process.

### Agent HTTP API (`/__gg/logs`)

The Vite plugin exposes a middleware endpoint for agent interaction. Same path, different HTTP methods:

| Method   | Endpoint                  | Description                                    | Response                                 |
| -------- | ------------------------- | ---------------------------------------------- | ---------------------------------------- |
| `DELETE` | `/__gg/logs`              | Truncate the JSONL file                        | `204 No Content`                         |
| `GET`    | `/__gg/logs`              | Read the JSONL file contents                   | `200` with `text/plain` body (raw JSONL) |
| `GET`    | `/__gg/logs?filter=api:*` | Read filtered entries (server-side grep)       | `200` with matching JSONL lines          |
| `GET`    | `/__gg/logs?since={ts}`   | Read entries after a timestamp                 | `200` with matching JSONL lines          |
| `GET`    | `/__gg/logs?env=server`   | Read only server-side or client-side entries   | `200` with matching JSONL lines          |
| `GET`    | `/__gg/logs?origin=tauri` | Read only Tauri webview or browser tab entries | `200` with matching JSONL lines          |

All query params can be combined: `GET /__gg/logs?filter=api:*&env=client&origin=tauri&since=1741234567890`.

**Why HTTP in addition to the file?**

- The agent doesn't need to know the file path or port-based naming convention
- Works even if the file path is customized via plugin options
- Follows the same pattern as `/__open-in-editor` and `/__gg/project-root` that already exist
- Enables `filter` and `since` query params for server-side filtering (more efficient than the agent grepping the whole file)

**Typical agent workflow:**

```bash
# 1. Clear logs before the action under investigation
curl -X DELETE http://localhost:5173/__gg/logs

# 2. Dev triggers the action (page load, button click, etc.)

# 3. Read only the relevant logs
curl http://localhost:5173/__gg/logs

# Or with filtering:
curl "http://localhost:5173/__gg/logs?filter=notify:*"
```

The `GET` endpoint reads the JSONL file and returns it as `text/plain`. When `filter` is provided, each line is parsed and matched against the namespace using the same glob matching as the Eruda UI. When `since` is provided, only entries with `ts >= since` are returned. Both can be combined.

**`DELETE` does not clear the browser ring buffer** -- it only truncates the file. The Eruda UI retains its entries. This is intentional: the agent controls the file, the developer controls the UI.

### Diagnostics

The existing `runGgDiagnostics()` function (`gg.ts:1264-1336`) checks for the call-sites plugin and open-in-editor plugin. The file sink plugin should follow the same pattern:

**Detection mechanism**: The file sink plugin exposes a `/__gg/status` endpoint (or piggybacks on `/__gg/logs` with a `HEAD` request) that the browser-side diagnostics can probe. Alternatively, the plugin can set a global flag via a virtual module or injected code that `runGgDiagnostics()` reads directly -- same approach as `_ggCallSitesPlugin`.

**Diagnostic output when active:**

```
✅ gg-file-sink vite plugin detected! Logs written to .gg/logs-5173.jsonl. Agent API at /__gg/logs.
```

**Diagnostic output when not active:**

```
ℹ️ (optional) gg-file-sink vite plugin not detected. Add fileSink: true to ggPlugins() options to write logs to .gg/logs-{port}.jsonl for coding agent access. See: https://github.com/Leftium/gg#agent-file-sink
```

Uses `ℹ️` (not `❌` or `⚠️`) because this is an optional feature that most users don't need. The `⚠️` is reserved for plugins that are broadly useful (like call-sites). The file sink is specifically for agent workflows -- an informational hint, not a recommendation for all users.

## Implementation Plan

### Phase 1: Core File Sink Plugin

- [x] **1.1** Create `src/lib/gg-file-sink-plugin.ts` -- Vite plugin with `configureServer` hook
- [x] **1.2** Server side: `server.hot.on('gg:log', ...)` handler that appends JSONL to `.gg/logs-{port}.jsonl`
- [x] **1.3** Server side: resolve port from server config, truncate/create `.gg/logs-{port}.jsonl` on server start (inside `configureServer`)
- [x] **1.4** Server side: ensure `.gg/` directory is created if missing
- [x] **1.5** Server side: `/__gg/logs` middleware -- `DELETE` truncates file (204), `GET` returns file contents as `text/plain` (200)
- [x] **1.6** Server side: `GET /__gg/logs?filter=` glob matching and `?since=` timestamp filtering
- [x] **1.7** Client side: inject `import.meta.hot.send('gg:log', serialized)` into the `_onLog` pipeline, guarded by `if (import.meta.hot)` for automatic prod tree-shaking. Stamp `env: 'client'` and `origin: 'tauri' | 'browser'` (detect once on init via `window.__TAURI_INTERNALS__`).
- [x] **1.8** Server side: SSR entries captured via transform injection + `globalThis.__ggFileSink` bridge. Uses `appendFileSync` for write-order preservation. Stamp `env: 'server'`. _(Implementation differs from original plan — see Server-Side Hook Points section)_
- [x] **1.9** Serialization: define the `SerializedEntry` subset (including `env`, `table` fields), handle non-serializable args gracefully
- [x] **1.10** Add to `ggPlugins()` in `vite.ts` as an opt-in plugin (`fileSink?: boolean | { dir?: string }`)
- [x] **1.11** Add diagnostics check in `runGgDiagnostics()` -- `HEAD /__gg/logs` probe, `✅` with file path and API URL when active, `ℹ️` hint when not active

### Phase 2: Integration and Polish

- [x] **2.1** Add `.gg/` to `.gitignore`
- [x] **2.2** Test with the demo app (`src/routes/`) -- entries appear in file for both client and SSR paths
- [ ] **2.3** Test with a non-SvelteKit Vite app (plain Vite + React/Vue) to verify framework-agnostic behavior
- [x] **2.4** Document in README: how to enable, file location, JSONL format, `jq`/`grep` commands, SSR guidance
- [ ] **2.5** Extract Agent Instructions Template into consuming projects' `AGENTS.md` (e.g., epicenter)

### Phase 3: Agent Ergonomics (future)

- [ ] **3.1** Consider server→browser filter push via `server.hot.send('gg:set-filter', pattern)` so agents can configure the Eruda UI filter remotely (e.g., `POST /__gg/filter` relays to browser via HMR)
- [ ] **3.2** Consider a `gg-keep` / `gg-show` file-based config (`.gg/config.json`) that the agent can write and the browser picks up via HMR

## Edge Cases

### Production Builds (Automatic No-Op)

1. App is built for production (`vite build`)
2. `import.meta.hot` is `undefined` in production -- Vite strips it entirely
3. The client-side sender is guarded by `if (import.meta.hot) { ... }`, which Vite tree-shakes to nothing. Zero bytes in the production bundle.
4. The `configureServer` hook only executes inside Vite's dev server process -- it does not exist in production builds at all.
5. No guard logic needed beyond what Vite already provides.

### Non-Serializable Arguments

1. `gg()` is called with a DOM node, circular object, or function as an argument
2. `JSON.stringify` of the raw args would throw
3. The serialized entry uses the pre-formatted `message` string (already a string) and omits `args`. No risk.

### High-Volume Logging

1. A loop calls `gg()` 10,000 times in quick succession
2. 10,000 HMR messages are sent, 10,000 file appends occur
3. Expected outcome: all entries are written. Async `appendFile` queues internally in Node.js. May want to add browser-side batching (collect entries for 16ms, send as array) if this becomes a real issue. Deferred to Phase 3.

### Dev Server Restart / HMR Reconnect

1. The Vite dev server restarts (config change, plugin update)
2. `.gg/logs-{port}.jsonl` is truncated on server start
3. The browser reconnects via HMR and resumes sending. Entries during the disconnect gap are lost (acceptable -- they're still in the browser's ring buffer).

### Agent Clear-Then-Observe Workflow

1. Agent calls `DELETE /__gg/logs` to clear the file
2. Agent instructs developer to perform an action (or triggers it via other means)
3. Agent calls `GET /__gg/logs` to read only the entries generated by that action
4. File contains a clean, focused set of log entries with no noise from prior interactions. This is the primary intended workflow -- more precise than relying on auto-truncate timing.

### SSR + Client Hydration (Interleaved Entries)

1. A SvelteKit page has `gg()` calls in both `+page.server.ts` (load function) and `+page.svelte` (component)
2. On page load, the server-side load function runs first -- entries are written with `env: "server"`
3. The page is sent to the browser, the component hydrates, and client-side `gg()` calls fire -- entries arrive via HMR with `env: "client"`
4. The JSONL file contains both, naturally ordered by time. The `env` and `origin` fields distinguish them:
   ```jsonl
   {"env":"server","ns":"gg:routes/+page.server.ts@load","msg":"Fetching data","ts":1741234567885,...}
   {"env":"server","ns":"gg:routes/+page.server.ts@load","msg":"Data ready: 42 items","ts":1741234567890,...}
   {"env":"client","origin":"browser","ns":"gg:routes/+page.svelte@onMount","msg":"Component mounted","ts":1741234568100,...}
   ```
5. Agent can see the full request lifecycle in one file, or filter to one side: `grep '"env":"server"'` or `GET /__gg/logs?env=client`.

### Tauri Webview + Browser Tab (Simultaneous Clients)

1. Developer runs `bun tauri dev`, which starts the Vite dev server and opens the Tauri webview -- the default workflow.
2. Developer (or a future agent with browser automation) also opens `localhost:1421` in a browser.
3. Both the Tauri webview and the browser tab connect to the same Vite HMR WebSocket. Both send `gg:log` events.
4. Entries from both sources are appended to the same JSONL file, distinguished by `origin`:
   ```jsonl
   {"env":"client","origin":"tauri","ns":"gg:routes/+page.svelte@onClick","msg":"Button clicked","ts":1741234567890,...}
   {"env":"client","origin":"browser","ns":"gg:routes/+page.svelte@onClick","msg":"Button clicked","ts":1741234567920,...}
   ```
5. Agent can filter: `grep '"origin":"tauri"'` or `GET /__gg/logs?origin=tauri` to see only the Tauri webview's entries.
6. If only the Tauri webview is open (the common case), all client entries have `origin: "tauri"` and no disambiguation is needed.

### Multiple Browser Tabs

1. Two tabs are open to the same dev server
2. Both send `gg:log` events over their respective WebSocket connections
3. All entries are appended to the same port-scoped file. Interleaved but each line is a complete JSON object. The `ns` and `file` fields provide context. No corruption risk since `appendFile` is atomic for small writes (< 4KB on POSIX) on most OS/filesystem combinations.

### Multiple Dev Servers / Zombie Processes

1. Developer starts a dev server on port 5173. Agent starts another on 5174. A zombie process lingers on 5175.
2. Each server writes to its own file: `.gg/logs-5173.jsonl`, `.gg/logs-5174.jsonl`, `.gg/logs-5175.jsonl`
3. No cross-contamination -- entries from different apps/instances never mix.
4. Port is resolved from `server.config.server.port` (or the actual resolved port after `server.listen()` if Vite auto-increments due to port conflicts).
5. Stale files from dead processes are harmless leftover files. The next server start on that port truncates its file. Agents can discover active log files via `ls .gg/logs-*.jsonl` and correlate with running processes if needed.
6. The `.gg/` directory may accumulate files from past sessions on different ports. This is acceptable -- they're small and can be cleaned up manually or by a future `gg clean` command.

## Open Questions

1. **Opt-in vs opt-out?**
   - **Resolved**: Opt-in (`fileSink: true`). Implemented.

2. **File path configurability?**
   - **Resolved**: Yes, via `fileSink: { dir: 'custom/dir' }`. Implemented.

3. **Should `args` be serialized with a safe stringify?**
   - **Resolved**: Deferred. `message` field contains the formatted string. `tableData` is now serialized as `table` field (structured, safe). `args` remains excluded.

4. **Client-side hook mechanism**
   - **Resolved**: `_onLog` converted to multi-listener via `addLogListener`/`removeLogListener`. `earlyLogBuffer` made persistent (never cleared, capped at 2000) so late-registering listeners (Eruda mounts after file-sink) still receive early entries. Implemented.

## Success Criteria

- [x] With `fileSink: true` in plugin options, `gg()` calls in the browser produce lines in `.gg/logs-{port}.jsonl` with `"env":"client"`
- [x] Server-side `gg()` calls (SSR, load functions, API routes) produce lines in the same file with `"env":"server"`
- [x] File is port-scoped -- multiple dev servers write to separate files
- [x] File is truncated on dev server start
- [x] Each line is valid JSON and independently parseable
- [x] Every line contains an `env` field (`"client"` or `"server"`)
- [x] Client entries contain an `origin` field (`"tauri"` or `"browser"`)
- [x] `jq 'select(.ns | startswith("some:namespace"))' .gg/logs-5173.jsonl` returns matching entries
- [x] `jq 'select(.env == "server")' .gg/logs-5173.jsonl` returns only server-side entries
- [x] `jq 'select(.origin == "tauri")' .gg/logs-5173.jsonl` returns only Tauri webview entries
- [x] `grep` equivalents also work: `grep '"env":"server"' .gg/logs-5173.jsonl`
- [x] `curl -X DELETE http://localhost:5173/__gg/logs` truncates the file and returns 204
- [x] `curl http://localhost:5173/__gg/logs` returns the full JSONL contents
- [x] `curl "http://localhost:5173/__gg/logs?filter=api:*&env=server"` returns only matching server entries
- [x] `curl "http://localhost:5173/__gg/logs?origin=tauri"` returns only Tauri webview entries
- [x] Eruda plugin continues to work normally (file sink does not interfere)
- [x] `DELETE` does not affect the browser-side ring buffer or Eruda UI
- [x] No file writes in production builds (client sender is tree-shaken, `configureServer` doesn't run)
- [x] No measurable dev server performance impact at typical logging volumes (verified with 3000-entry stress test in ~4s)

## Agent Instructions Template (for consuming projects' AGENTS.md)

The following content should be added to consuming projects' `AGENTS.md` (or equivalent agent instruction file) once the file sink is enabled. Adapt paths and port numbers as needed.

---

### Reading `gg()` Runtime Logs

This project uses `@leftium/gg` with the file sink plugin. All `gg()` calls — both browser-side and server-side — are captured to `.gg/logs-{port}.jsonl` during development.

**Log file location**: `.gg/logs-{port}.jsonl` (e.g., `.gg/logs-5173.jsonl`). Discover active log files with `ls .gg/logs-*.jsonl`.

**Workflow:**

1. **Instrument** — Ensure `gg()` calls exist in the code paths you want to observe. `gg()` is zero-config — just `import { gg } from '@leftium/gg'` and call `gg(value)`. Skip this step if the relevant calls are already in place.

2. **Reset** — Clear the log file so you're only reading entries from the action you care about.

   ```bash
   curl -X DELETE http://localhost:5173/__gg/logs
   ```

3. **Trigger** — Ask the user to perform the action under investigation (page load, button click, form submit, etc.). Wait for the user to confirm they're done.

4. **Query** — Read and filter the log entries. In SSR apps, component `gg()` calls appear twice — once as `env:"server"`, once as `env:"client"`. Pick the side you need, or use the dedup query for a full picture without duplicates.

   ```bash
   # Check the split first
   jq -s 'group_by(.env) | map({env: .[0].env, count: length})' .gg/logs-5173.jsonl

   # Client-side only (component behavior, user interactions)
   curl -s "http://localhost:5173/__gg/logs?env=client"

   # Server-side only (load functions, API routes, auth)
   curl -s "http://localhost:5173/__gg/logs?env=server"

   # Full picture without duplicates (server entries + client-only entries)
   jq -s '
     (map(select(.env == "server")) | map([.ns, .line] | join(":")) | unique) as $server_keys |
     map(select(
       .env == "server" or
       (([.ns, .line] | join(":")) | IN($server_keys[]) | not)
     ))
   ' .gg/logs-5173.jsonl

   # Errors only
   jq 'select(.lvl == "error")' .gg/logs-5173.jsonl
   ```

5. **Analyze** — Interpret the entries in context. The `file` and `line` fields point to source locations. The `ns` field shows the call site (file + function). The `env` field tells you whether the entry came from server-side (SSR, load functions) or client-side (browser, Tauri). If more data is needed, go back to step 1 and add more `gg()` calls.

This cycle — instrument, reset, trigger, query, analyze — is the primary debugging loop. Each iteration narrows the investigation.

**Each JSONL line contains:**

| Field    | Description                                                             |
| -------- | ----------------------------------------------------------------------- |
| `ns`     | Namespace (file + function, e.g., `gg:routes/+page.svelte@handleClick`) |
| `msg`    | Formatted message string                                                |
| `ts`     | Unix epoch ms                                                           |
| `lvl`    | `"debug"` \| `"info"` \| `"warn"` \| `"error"` (omitted if debug)       |
| `env`    | `"client"` or `"server"` — which runtime produced this entry            |
| `origin` | `"tauri"` \| `"browser"` (client entries only)                          |
| `file`   | Source file path                                                        |
| `line`   | Source line number                                                      |

**Querying with `jq` (preferred):**

```bash
# Check the env split first (useful in SSR apps)
jq -s 'group_by(.env) | map({env: .[0].env, count: length})' .gg/logs-5173.jsonl

# Client-side only (component behavior, user interactions)
jq 'select(.env == "client")' .gg/logs-5173.jsonl

# Server-side only (load functions, API routes, auth)
jq 'select(.env == "server")' .gg/logs-5173.jsonl

# Full picture without SSR duplicates — server entries + client-only entries (e.g. onMount)
jq -s '
  (map(select(.env == "server")) | map([.ns, .line] | join(":")) | unique) as $server_keys |
  map(select(
    .env == "server" or
    (([.ns, .line] | join(":")) | IN($server_keys[]) | not)
  ))
' .gg/logs-5173.jsonl

# Errors only
jq 'select(.lvl == "error")' .gg/logs-5173.jsonl

# Entries from a specific file
jq 'select(.file | contains("+page.svelte"))' .gg/logs-5173.jsonl

# Just messages as plain text
jq -r '.msg' .gg/logs-5173.jsonl

# Messages with source location
jq -r '"\(.file):\(.line) \(.msg)"' .gg/logs-5173.jsonl

# Count entries by namespace
jq -s 'group_by(.ns) | map({ns: .[0].ns, count: length}) | sort_by(-.count)' .gg/logs-5173.jsonl

# SSR hydration mismatches — call sites where server and client produced different values.
# Only flags entries where BOTH envs exist for the same [ns, line] AND msg differs.
# Call sites that only run server-side (auth checks) or client-side (onMount) are ignored.
jq -s '
  group_by([.ns, .line]) |
  map(select(map(.env) | (contains(["server"]) and contains(["client"])))) |
  map({
    ns: .[0].ns, line: .[0].line,
    server: (map(select(.env=="server")) | .[0].msg),
    client: (map(select(.env=="client")) | .[0].msg)
  }) |
  map(select(.server != .client))
' .gg/logs-5173.jsonl
```

**Querying with `grep` (fallback):**

```bash
# Server-side entries only (less precise — may false-match message content)
grep '"env":"server"' .gg/logs-5173.jsonl

# Entries mentioning a namespace pattern
grep '"ns":"gg:routes/+page' .gg/logs-5173.jsonl
```

**HTTP API (alternative to file access):**

```bash
# Read all logs
curl -s http://localhost:5173/__gg/logs

# Filter by namespace glob, environment, origin
curl -s "http://localhost:5173/__gg/logs?filter=api:*&env=server"
curl -s "http://localhost:5173/__gg/logs?origin=tauri"

# Entries after a timestamp
curl -s "http://localhost:5173/__gg/logs?since=1741234567890"

# Pipe through jq for further filtering
curl -s http://localhost:5173/__gg/logs | jq 'select(.lvl == "error")'
```

**Key details:**

- The `env` field distinguishes server-side (SSR, load functions, API routes) from client-side (browser, Tauri webview) entries.
- The `origin` field distinguishes Tauri webview (`"tauri"`) from browser tab (`"browser"`) when both connect to the same dev server. Only present on client entries.
- The file is truncated on dev server start. Use `DELETE /__gg/logs` to clear mid-session.
- Each line is independently valid JSON — partial file reads and streaming (`tail -f`) work.

**Opening files in the editor:**

Vite's dev server registers `/__open-in-editor` unconditionally on every dev server — no extra plugin required. Agents can use it to open the exact source location of any log entry directly in the developer's editor.

```bash
# Open the file+line from the first error entry
curl -s http://localhost:5173/__gg/logs \
  | jq -r 'select(.lvl == "error") | "/__open-in-editor?file=\(.file)&line=\(.line)"' \
  | head -1 \
  | xargs -I{} curl -s "http://localhost:5173{}"

# Open a specific file+line directly
curl "http://localhost:5173/__open-in-editor?file=src/routes/+page.svelte&line=42"
```

The endpoint accepts `file`, `line`, and `col` query params. `file` can be relative to the project root or absolute. The editor opens and positions the cursor at the specified location. The response is `222` (a non-standard status used by `launch-editor`) with a self-closing page — safe to discard.

Agents should use this proactively when they identify a relevant source location in log output: open the file for the developer rather than just citing `file:line` in text. This is especially useful after the analyze step — if an error or unexpected value is traced to a specific line, open it immediately.

---

## References

- `src/lib/vite.ts` -- existing `ggPlugins()` bundle where the new plugin will be added
- `src/lib/open-in-editor.ts` -- existing Vite plugin pattern with `configureServer` (model for the new plugin)
- `src/lib/gg.ts:546-566` -- `CapturedEntry` construction and `_onLogCallback` dispatch
- `src/lib/gg.ts:1177-1193` -- `_onLog` property definition and early buffer replay
- `src/lib/eruda/types.ts` -- `CapturedEntry` interface (source of truth for entry shape)
- `src/lib/eruda/buffer.ts` -- `LogBuffer` ring buffer (existing in-memory storage)
- [Vite HMR API](https://vite.dev/guide/api-hmr.html) -- `import.meta.hot.send()` and `server.hot.on()` docs
