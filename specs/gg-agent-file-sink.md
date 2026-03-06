# gg Agent File Sink: JSONL Log File via Vite HMR

**Date**: 2026-03-06
**Status**: Draft
**Author**: AI-assisted

## Overview

Mirror browser-side `gg()` log entries to a local JSONL file (`.gg/logs-{port}.jsonl`) by relaying `CapturedEntry` objects over Vite's existing HMR WebSocket to a new Vite plugin that appends them to disk. This gives coding agents (and any file-reading tool) direct access to runtime log output without clipboard, browser automation, or server-side application routes.

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
gg() call → _onLog hook → HMR WebSocket → Vite plugin → .gg/logs-5173.jsonl
                                                              ↑
                                              Agent reads/greps this file
```

The developer still triggers the UI action (page load, button click, etc.), but log collection is fully automatic. The agent reads `.gg/logs.jsonl` directly -- no clipboard, no paste, no browser needed.

## Research Findings

### Vite HMR Custom Events

Vite's HMR WebSocket supports custom event types in both directions:

| Direction | Browser API | Server API |
|-----------|-------------|------------|
| Browser → Server | `import.meta.hot.send(event, data)` | `server.hot.on(event, callback)` |
| Server → Browser | `import.meta.hot.on(event, callback)` | `server.hot.send(event, data)` |

**Key finding**: The WebSocket connection is already open for HMR. Custom messages add zero connection overhead. Payload size is the only cost.

**Implication**: Browser-to-server transport is essentially free infrastructure. No new connections, no polling, no middleware endpoints.

### File Write Performance

| Operation | Typical latency | Notes |
|-----------|----------------|-------|
| `fs.appendFile` (async) | 0.01-0.1ms | Non-blocking, suitable for hot path |
| `fs.appendFileSync` | 0.05-0.5ms | Blocks event loop, avoid |
| Batched write (100 entries) | ~0.1ms | Amortizes syscall overhead |

**Key finding**: At typical dev logging volumes (1-50 entries/sec), async `appendFile` is negligible. Even at 100 entries/sec, the file I/O cost is unmeasurable against normal Vite dev server work.

**Implication**: No batching needed on the server side. Append each entry as it arrives. Batching on the browser side (before sending over HMR) is optional but could reduce WebSocket message count for high-volume logging.

### JSONL vs SQLite

| Dimension | JSONL | SQLite |
|-----------|-------|--------|
| Agent readability | `grep` / `cat` -- universally available | Requires `sqlite3` CLI or library |
| Structured queries | Manual (jq, custom parsing) | Native (time ranges, aggregation, COUNT) |
| Append performance | `fs.appendFile` -- trivial | Transaction overhead per write |
| Concurrent access | Safe for small appends (< 4KB, POSIX atomic) | Built-in locking, but write contention possible |
| File inspection | Human-readable in any editor | Binary format, requires tooling |
| Corruption risk | One bad line, rest is fine | Corruption can affect entire DB |

**Key finding**: Every coding agent has `grep` and `cat`. Not every agent has `sqlite3`. For the primary use case -- "show me logs matching this pattern" -- `grep` on JSONL is equivalent to a SQL query and has zero dependencies.

**Implication**: JSONL is the right default. If structured queries become important later, a JSONL file can be loaded into SQLite after the fact. The reverse isn't true -- SQLite isn't grep-friendly.

### JSONL Format Details

One JSON object per line. Advantages for agents:

- `grep` works (no multi-line parsing needed)
- Append-only (no need to parse/rewrite the file)
- Streaming-friendly (tail -f equivalent)
- Each line is independently parseable (partial file reads work)

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport | Vite HMR custom events | WebSocket already open, zero additional infra. gg already ships Vite plugins. |
| File format | JSONL over SQLite | Every agent has `grep`; not every agent has `sqlite3`. JSONL is append-only, human-readable, corruption-tolerant. |
| File location | `.gg/logs-{port}.jsonl` | Port-scoped to isolate multiple dev servers. Grouped under `.gg/` for easy gitignore. Discoverable via `ls .gg/logs-*.jsonl`. |
| Truncation | Auto on server start + agent-initiated clear via HTTP | Auto-truncate prevents unbounded growth. Agent clear (`DELETE /__gg/logs`) gives precise control -- agent clears right before triggering an action, then reads only the relevant entries. |
| Browser-side batching | Optional, deferred | Simplicity first. One HMR message per `gg()` call. Batch later if profiling shows need. |
| Filtering | Agent-side (grep the file) | No server-side filter config needed. JSONL fields are greppable. Agent uses its own tools. |
| Serialization | Subset of CapturedEntry fields | Skip `args` (may contain non-serializable objects). Include namespace, message, timestamp, level, file, line, src. |
| Activation | Dev-only, opt-in via plugin option | No file I/O in production. Explicit opt-in prevents surprise disk writes. |
| Production behavior | Automatic no-op, zero bundle cost | `import.meta.hot` is `undefined` in prod builds -- Vite dead-code-eliminates the client sender. `configureServer` only runs in dev. |

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
│       ├───────────────────────────────► │      fs.appendFile(          │
│       │  hot.send(     │  'gg:log'      │        `.gg/logs-${port}     │
│       │   'gg:log',    │                │          .jsonl`,            │
│       │    serialized) │                │        JSON.stringify(entry) │
│       │                │                │        + '\n'                │
│       ▼                │                │      )                       │
│  LogBuffer.push(entry) │                │    })                        │
│  (existing flow)       │                │                              │
│                        │                │  configureServer:            │
│  import.meta.hot is    │                │    resolve port              │
│  undefined in prod     │                │    truncate on start         │
│  → entire sender is    │                │                              │
│    tree-shaken away    │                │  middleware:                 │
│                        │                │    DELETE /__gg/logs → clear │
│                        │                │    GET /__gg/logs → read     │
│                        │                │                              │
│                        │                │  configureServer only runs   │
│                        │                │  in dev → no-op in prod      │
└────────────────────────┘                └──────────────────────────────┘
                                                     │
                                                     ▼
                                          .gg/logs-5173.jsonl
                                          ┌──────────────────────────┐
                                          │ {"ns":"api:fetch",...}   │
                                          │ {"ns":"auth:login",...}  │
                                          │ {"ns":"api:fetch",...}   │
                                          └──────────────────────────┘
                                                     ↑
                                          Agent reads file directly
                                          or via GET /__gg/logs
```

### Serialized Entry Format

Each JSONL line contains a subset of `CapturedEntry` fields, chosen for agent utility and safe serialization:

```jsonl
{"ns":"routes/+page.svelte@handleClick","msg":"Processing item: {id: 42}","ts":1741234567890,"lvl":"warn","file":"src/routes/+page.svelte","line":42,"src":"item","diff":12}
```

| Field | Source | Description |
|-------|--------|-------------|
| `ns` | `namespace` | Namespace string (greppable) |
| `msg` | `message` | Formatted message string |
| `ts` | `timestamp` | Unix epoch ms |
| `lvl` | `level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` (omitted if debug) |
| `file` | `file` | Source file path |
| `line` | `line` | Source line number |
| `src` | `src` | Source expression text (icecream-style) |
| `diff` | `diff` | Ms since previous log in same namespace |

**Excluded**: `args` (may contain circular refs, DOM nodes, non-serializable objects), `color` (cosmetic), `col` (rarely useful), `stack` (large, could be opt-in), `tableData` (complex structure).

### Client-Side Hook Point

The hook inserts into the existing `_onLogCallback` flow in `gg.ts`. Rather than modifying the callback directly, the Vite plugin injects a small client module that wraps the existing hook:

```
STEP 1: Plugin injects client-side HMR sender
──────────────────────────────────────────────
The gg-file-sink Vite plugin uses Vite's virtual module or transform
to inject code that registers an additional _onLog listener.
This runs alongside the existing Eruda hook -- both receive entries.

STEP 2: Browser serializes and sends
─────────────────────────────────────
On each gg() call, the injected code serializes the CapturedEntry
(stripping non-serializable fields) and calls import.meta.hot.send('gg:log', data).

STEP 3: Vite plugin receives and writes
────────────────────────────────────────
The plugin's configureServer hook registers server.hot.on('gg:log', ...)
which appends the JSON line to .gg/logs.jsonl.
```

### Agent HTTP API (`/__gg/logs`)

The Vite plugin exposes a middleware endpoint for agent interaction. Same path, different HTTP methods:

| Method | Endpoint | Description | Response |
|--------|----------|-------------|----------|
| `DELETE` | `/__gg/logs` | Truncate the JSONL file | `204 No Content` |
| `GET` | `/__gg/logs` | Read the JSONL file contents | `200` with `text/plain` body (raw JSONL) |
| `GET` | `/__gg/logs?filter=api:*` | Read filtered entries (server-side grep) | `200` with matching JSONL lines |
| `GET` | `/__gg/logs?since={ts}` | Read entries after a timestamp | `200` with matching JSONL lines |

**Why HTTP in addition to the file?**

- The agent doesn't need to know the file path or port-based naming convention
- Works even if the file path is customized via plugin options
- Follows the same pattern as `/__open-in-editor` and `/__gg-project-root` that already exist
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

- [ ] **1.1** Create `src/lib/gg-file-sink-plugin.ts` -- Vite plugin with `configureServer` hook
- [ ] **1.2** Server side: `server.hot.on('gg:log', ...)` handler that appends JSONL to `.gg/logs-{port}.jsonl`
- [ ] **1.3** Server side: resolve port from server config, truncate/create `.gg/logs-{port}.jsonl` on server start (inside `configureServer`)
- [ ] **1.4** Server side: ensure `.gg/` directory is created if missing
- [ ] **1.5** Server side: `/__gg/logs` middleware -- `DELETE` truncates file (204), `GET` returns file contents as `text/plain` (200)
- [ ] **1.6** Server side: `GET /__gg/logs?filter=` glob matching and `?since=` timestamp filtering
- [ ] **1.7** Client side: inject `import.meta.hot.send('gg:log', serialized)` into the `_onLog` pipeline, guarded by `if (import.meta.hot)` for automatic prod tree-shaking
- [ ] **1.8** Serialization: define the `SerializedEntry` subset, handle non-serializable args gracefully
- [ ] **1.9** Add to `ggPlugins()` in `vite.ts` as an opt-in plugin (e.g., `fileSink?: boolean | { dir?: string }`)
- [ ] **1.10** Add diagnostics check in `runGgDiagnostics()` -- probe for plugin presence, show `ℹ️` hint with install instructions when not active, `✅` with file path and API URL when active

### Phase 2: Integration and Polish

- [ ] **2.1** Add `.gg/` to the project's `.gitignore` template / documentation
- [ ] **2.2** Test with the demo app (`src/routes/`) -- verify entries appear in the file
- [ ] **2.3** Test with a non-SvelteKit Vite app (plain Vite + React/Vue) to verify framework-agnostic behavior
- [ ] **2.4** Document in README: how to enable, file location, JSONL format, example grep commands

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
   - Options: (a) Off by default, enabled via `fileSink: true` in plugin options, (b) On by default in dev mode
   - **Recommendation**: Opt-in (a). Writing to the filesystem is a side effect that users should explicitly enable. Can revisit once the feature is proven.

2. **File path configurability?**
   - The default `.gg/logs-{port}.jsonl` is a sensible convention. Should users be able to override the directory or filename pattern?
   - **Recommendation**: Yes, via `fileSink: { dir: 'custom/dir' }`. The port suffix should always be appended to prevent multi-server collisions. Default `.gg/` is good enough for most cases.

3. **Should `args` be serialized with a safe stringify?**
   - Could use a `JSON.stringify` replacer that handles circular refs, DOM nodes, etc.
   - **Recommendation**: Defer. The `message` field already contains the formatted string representation. Adding safe `args` serialization is useful for structured queries but adds complexity. Start without it.

4. **Client-side hook mechanism**
   - The current `_onLog` is a single callback (set by Eruda plugin). The file sink needs to also receive entries.
   - Options: (a) Chain callbacks -- the file sink wraps the existing callback, (b) Convert to an event emitter / array of listeners, (c) The file sink taps into `earlyLogBuffer` replay + wraps `_onLog`
   - **Recommendation**: (b) Convert `_onLog` to support multiple listeners. This is a small internal change and future-proofs for other consumers.

## Success Criteria

- [ ] With `fileSink: true` in plugin options, `gg()` calls in the browser produce lines in `.gg/logs-{port}.jsonl`
- [ ] File is port-scoped -- multiple dev servers write to separate files
- [ ] File is truncated on dev server start
- [ ] Each line is valid JSON and independently parseable
- [ ] `grep '"ns":"some:namespace"' .gg/logs-5173.jsonl` returns matching entries
- [ ] `curl -X DELETE http://localhost:5173/__gg/logs` truncates the file and returns 204
- [ ] `curl http://localhost:5173/__gg/logs` returns the full JSONL contents
- [ ] `curl "http://localhost:5173/__gg/logs?filter=api:*"` returns only matching entries
- [ ] Eruda plugin continues to work normally (file sink does not interfere)
- [ ] `DELETE` does not affect the browser-side ring buffer or Eruda UI
- [ ] No file writes in production builds (client sender is tree-shaken, `configureServer` doesn't run)
- [ ] No measurable dev server performance impact at typical logging volumes (< 100 entries/sec)

## References

- `src/lib/vite.ts` -- existing `ggPlugins()` bundle where the new plugin will be added
- `src/lib/open-in-editor.ts` -- existing Vite plugin pattern with `configureServer` (model for the new plugin)
- `src/lib/gg.ts:546-566` -- `CapturedEntry` construction and `_onLogCallback` dispatch
- `src/lib/gg.ts:1177-1193` -- `_onLog` property definition and early buffer replay
- `src/lib/eruda/types.ts` -- `CapturedEntry` interface (source of truth for entry shape)
- `src/lib/eruda/buffer.ts` -- `LogBuffer` ring buffer (existing in-memory storage)
- [Vite HMR API](https://vite.dev/guide/api-hmr.html) -- `import.meta.hot.send()` and `server.hot.on()` docs
