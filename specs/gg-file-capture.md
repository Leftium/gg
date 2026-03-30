# File Capture: DOM Snapshots & Arbitrary Files

**Date**: 2026-03-31
**Status**: Draft
**Author**: AI-assisted

## Overview

Add two new APIs to gg for persisting debug artifacts alongside the existing JSONL log stream:

- `gg.file(name, data)` — persist any serializable data as a named file (the primitive)
- `gg.dom(selector, options?)` — capture a DOM element as SVG/WebP (sugar built on `gg.file()`)

Files are stored on disk via `node:fs`, served at `/__gg/files/<id>`, and referenced from log entries by URL. The primary consumer is an automated agent that fetches file URLs from the logs. Human consumers get a lightweight viewer page with copy/download controls.

## Motivation

### Why Files, Not Just Logs

Text logs capture _events_. Files capture _state_ — a snapshot of what the DOM looks like, what the component props are, what the API returned. An agent debugging a rendering bug needs both: the log tells it _when_ something happened, the file shows _what it looked like_.

### Why DOM Snapshots

Automated coding agents can read `gg()` text logs via `/__gg/logs`, but have no way to see what the UI actually looks like. A DOM snapshot closes this gap — the agent fetches a URL, feeds the image to its vision model, and reasons about layout, styling, or rendering bugs. This must work from mobile devices (no headless browser).

### Why Not `html2canvas`

`html2canvas` re-implements CSS rendering in JavaScript using Canvas 2D API calls. Fidelity is mediocre — many CSS features are missing or buggy (`box-shadow`, `filter`, `clip-path`, `backdrop-filter`, complex gradients, transforms). The library is stale and self-described as "very experimental."

### Why `html-to-image` (SVG `foreignObject`)

`html-to-image` (or its successor `modern-screenshot`) uses a different approach:

1. Clone the target DOM node recursively
2. Inline all computed styles onto each cloned node
3. Embed fonts and images as base64 data URLs
4. Serialize into `<svg><foreignObject>...</foreignObject></svg>`
5. Optionally rasterize to WebP via an off-screen canvas

Because the **browser's own rendering engine** processes the SVG `foreignObject`, CSS fidelity is near-perfect — whatever the browser renders, the snapshot captures. The library is ~10KB minified.

### Why URL References Instead of Inline Data

Embedding files as base64 in log entries would bloat `.gg/logs-*.jsonl` and hit browser limits (Firefox caps CSS data URLs at 8KB). Instead, log entries contain a short URL. Benefits:

- Log files stay compact (a URL is ~60 bytes vs. hundreds of KB for an image)
- No size limits on the served file
- Works for all consumers: agent fetches URL, human clicks URL, terminal displays URL
- Agents and humans access the same canonical artifact

## API

### `gg.file(name, data)` — The Primitive

Persists arbitrary data as a named file. This is the foundation that `gg.dom()` builds on.

```ts
gg.file('state.json', $state.snapshot(props));
gg.file('response.json', await res.json());
gg.file('fragment.html', document.querySelector('.widget').outerHTML);
gg.file('debug.txt', someString);
```

**Parameters:**

| Parameter | Type               | Default  | Description                                                           |
| --------- | ------------------ | -------- | --------------------------------------------------------------------- |
| `name`    | `string`           | required | Filename with extension (used for Content-Type inference and display) |
| `data`    | `string \| object` | required | String is stored as-is. Objects are JSON-serialized.                  |

**Returns:** `void` (fire-and-forget, like other `gg()` calls)

**Name collision policy: overwrite.** If `gg.file()` is called multiple times with the same `name`, the file on disk is overwritten with the latest data. Each call still produces a log entry in `/__gg/logs`, so the agent can see that the file was updated N times (with timestamps and callsites), but only the latest version is retrievable from `/__gg/files/`.

This is the right default because:

- `gg.file('state.json', ...)` in a reactive block or event handler may fire hundreds of times — storing every version would fill `.gg/files/` with garbage
- The agent usually wants _current_ state, not a history of every reactive update
- For explicit before/after comparisons, use distinct names: `gg.file('state-before.json', before)` / `gg.file('state-after.json', after)`

Append mode (`{ append: true }`) is deliberately omitted. Accumulating entries over time is what the existing `gg()` log stream does — agents can filter it with `jq`. If append to a custom-format file proves necessary, it's a non-breaking addition later.

**Behavior:**

1. Serialize `data` (JSON.stringify if object, raw string otherwise)
2. POST to `/__gg/files`
3. Server stores the file (overwriting if name already exists), reuses the existing `fileId` for the same name, appends a log entry

### `gg.dom(target, options?)` — DOM Capture (Built on `gg.file`)

Captures a DOM element as an image. Internally, this captures the element then calls `gg.file()` to persist the result.

```ts
// CSS selector
gg.dom('#app > .main-content');
gg.dom('.hero-section', { format: 'webp' });
gg.dom('body', { format: 'webp', scale: 2 });
gg.dom('.photo-gallery', { format: 'webp', quality: 0.8 }); // lossy

// Direct element reference
let container; // bind:this in Svelte
gg.dom(container);

// From event handler
function handleClick(e) {
	gg.dom(e.currentTarget);
}
```

**Parameters:**

| Parameter         | Type                | Default  | Description                                                                                   |
| ----------------- | ------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `target`          | `string \| Element` | required | CSS selector or direct DOM element reference                                                  |
| `options.format`  | `'svg' \| 'webp'`   | `'svg'`  | Capture format. SVG is lossless and fast. WebP rasterizes via off-screen canvas.              |
| `options.scale`   | `number`            | `1`      | Device pixel ratio for WebP rasterization (ignored for SVG)                                   |
| `options.quality` | `number`            | `1`      | WebP quality, 0–1. Default 1 = lossless. Values < 1 = lossy (smaller files). Ignored for SVG. |

**Returns:** `void` (fire-and-forget)

**Behavior:**

1. Resolve target: if `string`, call `document.querySelector(target)` (warn if not found). If `Element`, use directly.
2. Capture the element using the SVG `foreignObject` approach (clone, inline styles, embed resources)
3. If `format: 'webp'`, rasterize the SVG to WebP via off-screen canvas (lossless by default, lossy if `quality < 1`)
4. Call `gg.file()` internally to persist the result(s)

When `format: 'webp'`, both SVG and WebP are stored — the SVG is always captured as an intermediate step, so it's free to keep. WebP is lossless by default (`quality: 1`), matching PNG quality in a smaller file. Set `quality < 1` for lossy compression (covers the JPEG use case, same format, still supports transparency).

**Relationship to `gg.file()`:**

```
gg.dom('.selector')
  → resolve target (querySelector or use Element directly)
  → captureDOM(element)              // html-to-image: toSvg(element)
  → gg.file('dom-<id>.svg', svgData) // persist via the primitive
```

This separation means:

- `gg.file()` can be used and tested independently of DOM capture
- The DOM capture library is only loaded when `gg.dom()` is called (dynamic import)
- If someone wants custom capture logic, they can capture however they like and call `gg.file()` directly

### Log Entries

Both `gg.dom()` and `gg.file()` produce log entries in `/__gg/logs`:

```jsonl
{
	"ns": "gg:dom",
	"msg": "#app > .main-content",
	"type": "file",
	"fileId": "a1b2c3",
	"fileName": "dom-a1b2c3.svg",
	"mimeType": "image/svg+xml",
	"ts": 1711900000,
	"env": "client",
	"file": "src/routes/+page.svelte",
	"line": 42
}
```

```jsonl
{
	"ns": "gg:file",
	"msg": "state.json",
	"type": "file",
	"fileId": "d4e5f6",
	"fileName": "state.json",
	"mimeType": "application/json",
	"ts": 1711900001,
	"env": "client",
	"file": "src/routes/+page.svelte",
	"line": 55
}
```

New fields on `SerializedEntry`:

| Field      | Type     | Description                                      |
| ---------- | -------- | ------------------------------------------------ |
| `type`     | `'file'` | Distinguishes file entries from text log entries |
| `fileId`   | `string` | Unique ID for the stored file                    |
| `fileName` | `string` | Original or generated filename (with extension)  |
| `mimeType` | `string` | MIME type inferred from extension                |

The `msg` field contains the selector string (for `gg.dom` with a CSS selector), a best-effort identifier like tag name + id/class (for `gg.dom` with a direct Element), or the filename (for `gg.file`) — for readability in text-based log views.

## Serving Endpoints

### `/__gg/files/<id>` — Viewer Page (HTML)

A self-contained HTML page (inline CSS/JS, no framework dependencies) that adapts based on content type:

**For images (SVG/WebP):**

- Renders the image centered on a checkerboard transparency background
- Toolbar: **Copy as PNG**, **Download SVG**, **Download WebP**, **Zoom**

**For JSON:**

- Syntax-highlighted, collapsible tree view
- Toolbar: **Copy**, **Download**

**For HTML/text:**

- Syntax-highlighted code view
- Toolbar: **Copy**, **Download**

**All types:**

- Shows metadata: filename, MIME type, timestamp, source file/line, size
- Served with `Content-Type: text/html`

### `/__gg/files/<id>.<ext>` — Raw File

- Serves the file with the appropriate `Content-Type`
- `/__gg/files/d4e5f6.json` → `application/json`
- Used by agents for direct consumption

For DOM captures specifically, there are exactly two raw URLs:

- `/__gg/files/<id>.svg` — always exists (the lossless SVG original)
- `/__gg/files/<id>.webp` — capture-time WebP if `format: 'webp'` was used, otherwise rasterized from SVG on demand

This means the agent doesn't need to know what format was captured — `.svg` always works for the lossless version, `.webp` always works for a raster version. The log entry records the original capture format as metadata.

### `/__gg/files` — Index

- **GET**: Lists all captured files as JSON: `[{ id, fileName, mimeType, timestamp, size, url }, ...]`
- **DELETE**: Clears all stored files

## Storage

Files are stored in `.gg/files/` alongside the existing `.gg/logs-*.jsonl`:

```
.gg/
  logs-5173.jsonl
  files/
    dom-a1b2c3.svg       # DOM snapshot (SVG)
    dom-a1b2c3.webp      # DOM snapshot (WebP, only if format: 'webp')
    d4e5f6.json          # JSON state capture
    g7h8i9.html          # HTML fragment
```

- Directory created on first file capture
- Files persist across page reloads (same lifetime as log files)
- Cleared via `DELETE /__gg/files` (or when `DELETE /__gg/logs` is called)
- `.gg/` is already gitignored

Persistence uses `node:fs` — the same 6-line pattern already proven in the file sink (`mkdirSync`, `writeFileSync`, `readFileSync`). No new dependencies for storage.

## Transport: Browser → Server

File data is sent via HTTP POST (not HMR WebSocket) because:

- Files can be large (hundreds of KB for images); WebSocket messages have practical size limits
- POST is already used as fallback for log entries
- Fire-and-forget semantics are fine

```
POST /__gg/files
Content-Type: application/json

{
  "fileName": "dom-snapshot.svg",
  "mimeType": "image/svg+xml",
  "data": "<svg>...</svg>",
  "meta": {
    "selector": "#app > .main-content",
    "file": "src/routes/+page.svelte",
    "line": 42,
    "ns": "gg:dom"
  }
}
```

For WebP captures, both files are sent in the same request:

```
POST /__gg/files
Content-Type: application/json

{
  "fileName": "dom-snapshot",
  "files": {
    "svg": "<svg>...</svg>",
    "webp": "<base64-encoded-webp>"
  },
  "meta": { ... }
}
```

Server responds with `{ "id": "a1b2c3" }`, writes the file(s), and appends the log entry.

## Design Decisions

| Decision                        | Choice                                            | Rationale                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gg.dom()` built on `gg.file()` | `gg.file()` is the primitive; `gg.dom()` is sugar | Clean separation: `gg.file()` handles persistence, `gg.dom()` handles DOM capture. Testable independently. Users can capture with custom logic and call `gg.file()` directly.                                                                        |
| API naming: `gg.dom()`          | Not `gg.image`, `gg.snap`, `gg.capture`           | Short, consistent with gg's terse style. CSS selector argument makes DOM context obvious. Called occasionally, not on every line — brevity over explicitness is fine.                                                                                |
| Generalized file storage        | `/__gg/files/` not `/__gg/images/`                | DOM snapshots are one use case. JSON state, HTML fragments, text are equally valuable for agents. Same infrastructure serves all.                                                                                                                    |
| Default image format            | SVG                                               | Lossless, fast to capture, compact (text-based, compresses well). Agents can consume SVG directly via vision models.                                                                                                                                 |
| Single raster format: WebP      | Not PNG, not JPEG — WebP only                     | WebP supports both lossless (replaces PNG) and lossy (replaces JPEG) in one format, with transparency. One raster URL per capture (`<id>.webp`), no format ambiguity. Universal browser support since 2020. All major vision-model APIs accept WebP. |
| DOM capture endpoint scheme     | `<id>.svg` (always), `<id>.webp` (on demand)      | Two URLs per capture, no format negotiation. Agent doesn't need to know capture options — `.svg` for lossless, `.webp` for raster, always. Capture-time WebP served if available, else rasterized from SVG.                                          |
| Persistence layer               | `node:fs` (existing)                              | 6 lines of proven, synchronous code. Survives restarts. No new dependencies.                                                                                                                                                                         |
| No `/__gg/bash` endpoint        | Deferred                                          | Agents with tool access already have real `bash`, `jq`, `curl`. A sandboxed bash endpoint adds complexity for a niche use case (browser-only or MCP-only agents). Can be added later if demand emerges.                                              |
| Log entry format                | URL reference, not inline data                    | Keeps logs compact. Agent fetches file separately.                                                                                                                                                                                                   |
| Transport                       | HTTP POST, not WebSocket                          | Large payloads; no ack needed; already-established pattern.                                                                                                                                                                                          |
| Viewer page                     | Self-contained HTML, adapts to content type       | No build step, no framework dependency. Copy-as-PNG (clipboard requires PNG) is the key value-add for images.                                                                                                                                        |
| DOM-to-image library            | `html-to-image` or `modern-screenshot`            | SVG `foreignObject` approach — browser renders CSS natively, near-perfect fidelity. ~10KB.                                                                                                                                                           |
| SSR behavior                    | `gg.dom()` is no-op; `gg.file()` works            | `gg.dom()` requires `document`. `gg.file()` can serialize data server-side via the globalThis bridge.                                                                                                                                                |
| Name collision                  | Overwrite, no append                              | Same name = latest state wins. Reactive blocks may fire hundreds of times — storing every version is waste. History is in the log entries. Append is what `gg()` itself does.                                                                        |

## Implementation Plan

### Phase 1: File Storage & Serving Infrastructure

- [ ] **1.1** In `gg-file-sink-plugin.ts`, create `.gg/files/` directory alongside log file on server start.
- [ ] **1.2** Add `POST /__gg/files` handler: validate payload, generate ID, write file(s) to `.gg/files/`, append log entry to JSONL.
- [ ] **1.3** Add `GET /__gg/files/<id>.<ext>` — serve raw file with correct Content-Type.
- [ ] **1.4** Add `GET /__gg/files/<id>` — serve viewer HTML page.
- [ ] **1.5** Add `GET /__gg/files` — list all captured files as JSON.
- [ ] **1.6** Add `DELETE /__gg/files` — clear all stored files.
- [ ] **1.7** Extend `SerializedEntry` type with `type`, `fileId`, `fileName`, `mimeType` fields.

### Phase 2: `gg.file()` Client-Side API

- [ ] **2.1** Add `gg.file(name, data)` method to `gg.ts`.
- [ ] **2.2** Implement serialization (JSON.stringify for objects, raw for strings).
- [ ] **2.3** POST to `/__gg/files`, dispatch log entry to `_logListeners`.
- [ ] **2.4** Also make `gg.file()` work server-side (SSR): detect `globalThis.__ggFileSink` and write directly via a `writeFile()` method on the bridge.

### Phase 3: `gg.dom()` Client-Side API

- [ ] **3.1** Evaluate `html-to-image` vs `modern-screenshot` — bundle size, maintenance, mobile Safari compat, TypeScript types. Pick one.
- [ ] **3.2** Add chosen library as a dependency (or vendor if small enough). Dynamic import on first `gg.dom()` call.
- [ ] **3.3** Add `gg.dom(selector, options?)` method to `gg.ts`. Guard with `BROWSER` check — no-op in SSR.
- [ ] **3.4** Implement capture flow: querySelector → foreignObject SVG. Optionally rasterize to WebP.
- [ ] **3.5** Internally call `gg.file()` to persist the result(s).

### Phase 4: Viewer Page

- [ ] **4.1** Create self-contained HTML template (inline CSS/JS) served at `/__gg/files/<id>`.
- [ ] **4.2** Image viewer: checkerboard background, zoom, copy-as-PNG (clipboard requires PNG), download SVG/WebP.
- [ ] **4.3** JSON viewer: syntax highlighting, collapsible tree.
- [ ] **4.4** Text/HTML viewer: syntax highlighting, copy, download.

### Phase 5: Integration & Testing

- [ ] **5.1** Test `gg.dom()` on Chrome desktop, Chrome Android, Safari iOS.
- [ ] **5.2** Test with complex DOM: Tailwind styles, custom fonts, embedded images, pseudo-elements.
- [ ] **5.3** Test `gg.file()` with JSON, HTML, and plain text.
- [ ] **5.4** Verify agent workflow: `gg.dom('.selector')` → `curl /__gg/logs` → extract URL → `curl /__gg/files/<id>.svg`.
- [ ] **5.5** Test in kit-demos and epicenter consumer projects.

## Edge Cases

### Element Not Found (`gg.dom`)

If `target` is a string and `document.querySelector(target)` returns `null`, log a `gg.warn()` with the selector. No file entry is created. If `target` is a direct Element reference, this can't happen (but guard against `null`/`undefined` being passed).

### Cross-Origin Resources (`gg.dom`)

Images or fonts loaded from different origins will be missing from the snapshot (browser security). The SVG `foreignObject` approach inherits CORS restrictions. Acceptable — most app assets are same-origin.

### Very Large DOM Trees (`gg.dom`)

Full-page captures (`body`) of complex apps may produce large SVGs (several MB). Mitigation: the capture is async and fire-and-forget — it won't block the UI. Storage is on disk, not in memory.

### Circular References (`gg.file`)

`JSON.stringify` throws on circular references. Catch and fall back to a structured-clone-safe serialization or log a warning.

### Same Name from Multiple Callsites (`gg.file`)

Two components both calling `gg.file('state.json', ...)` will overwrite each other. This is by design — the name is the user's chosen identifier. If they want distinct files, they use distinct names. The log entries preserve the full history (which callsite wrote which version and when).

### Multiple `gg.dom()` Captures in Quick Succession

Each `gg.dom()` call generates a unique filename (`dom-<id>.svg`) since it builds on `gg.file()` with a generated name. No collision.

### Production Builds

`gg.dom()` and `gg.file()` follow the same enable/disable logic as `gg()`. In production with gg disabled, they're no-ops. The DOM capture library is dynamically imported so it doesn't bloat production bundles.

### Safari `foreignObject` Quirks

Safari has known issues with `foreignObject` rendering (images may repeat or clip). WebP capture (which rasterizes via canvas in the browser) may produce better results on Safari since rasterization happens before the SVG quirks manifest.

### SSR for `gg.file()`

Unlike `gg.dom()` (which needs `document`), `gg.file()` can work in SSR. It serializes data and writes via `globalThis.__ggFileSink` (the same bridge used for log entries). The file sink plugin handles storage.

## Open Questions

1. **Which DOM-to-image library?** `html-to-image` (7.1K stars, established) vs `modern-screenshot` (fork/rewrite, possibly better maintained). Needs evaluation.

2. **Dynamic import of capture library?** To avoid bundling ~10KB into every gg consumer, `gg.dom()` could dynamically import the capture library on first use. Adds latency to first capture but keeps the base bundle lean.

3. **Viewer page URL scheme?** `/__gg/files/<id>` (no extension) = viewer, `.<ext>` = raw. Alternative: `/__gg/files/<id>?view` = viewer. The extensionless-as-viewer approach mirrors how GitHub serves blob pages vs raw content.

4. **File retention policy?** Currently files persist until explicitly deleted. Should there be auto-cleanup (max count, max age, max disk usage)?

5. **Eruda / GgConsole integration?** Render file entries as clickable thumbnails (images) or expandable previews (JSON). Not required for the agent use case. Deferred to a follow-up.

6. **`gg.file()` in SSR — transport?** Server-side `gg.file()` can write directly to `.gg/files/` via `globalThis.__ggFileSink`. No HTTP POST needed. Should the file sink bridge expose a `writeFile()` method alongside `write()`?

7. **`just-bash` query layer?** Deferred from this spec. Agents with tool access can already `curl /__gg/files/<id>.json | jq ...` using their native shell. A sandboxed `/__gg/bash` endpoint could be added later for browser-only or MCP-only agents that lack shell access.

## Success Criteria

- [ ] `gg.dom('.selector')` captures the element and stores SVG (and optionally WebP) server-side
- [ ] `gg.file('name.json', obj)` stores arbitrary JSON server-side
- [ ] `curl /__gg/logs` shows file entries with `type: "file"`, `fileId`, `mimeType`
- [ ] `curl /__gg/files/<id>.svg` returns a valid SVG that visually matches the DOM element
- [ ] `curl /__gg/files/<id>.json` returns valid JSON
- [ ] `/__gg/files/<id>` in a browser shows the viewer page with appropriate controls per content type
- [ ] Works on Chrome desktop, Chrome Android, and Safari iOS
- [ ] No impact on bundle size when `gg.dom()` / `gg.file()` are not used
- [ ] No-op in SSR (`gg.dom`) and production (when gg is disabled)

## References

- `src/lib/gg.ts` — Core module: add `gg.dom()` and `gg.file()` methods
- `src/lib/gg-file-sink-plugin.ts` — Plugin: add `/__gg/files` endpoints and file storage
- `src/lib/eruda/types.ts` — `CapturedEntry` / `SerializedEntry` types: add file fields
- `html-to-image`: https://github.com/bubkoo/html-to-image
- `consoleimg` (prior art, CSS `%c` approach): https://github.com/workeffortwaste/consoleimg
