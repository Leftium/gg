# File Sink: Fix for External Consumers

**Date**: 2025-03-10
**Status**: Draft
**Author**: AI-assisted

## Overview

The gg file sink plugin writes gg() log entries to a JSONL file for coding agent access. It works in gg's own dev repo but fails silently when consumed as an npm dependency. The fix is simple: gg.ts should write to the log file directly via a `globalThis` bridge, the same way the middleware endpoints "just work" — pure server-side, no code injection needed.

## Motivation

### Why Middleware Works but Log Capture Doesn't

The file sink has two parts:

1. **Middleware** (`/__gg/`, `/__gg/logs`, etc.) — registers HTTP endpoints in `configureServer`. Request in, response out. Works everywhere, like `/__open-in-editor`. No browser JavaScript involved.

2. **Log capture** — intercepts gg() calls and writes entries to the JSONL file. Currently uses a `transform` hook to inject `addLogListener` code into gg.ts. This is where it breaks.

The middleware "just works" because it's pure server-side. Log capture breaks because it depends on injecting code into a library module — and that injection never fires for external dependencies.

### Root Cause

The `transform` hook checks `if (id !== ggModulePath) return null`, where `ggModulePath` resolves to paths like `node_modules/@leftium/gg/src/lib/gg.ts`. But:

- The published npm package has no `src/` — only `dist/`
- Even if it found `dist/gg.js`, esbuild pre-bundles it into `.vite/deps/@leftium_gg.js` — the transform sees the pre-bundled ID, never the original path

The transform never fires. The `addLogListener` + write code is never injected. Zero entries.

### The Fix in One Sentence

Make log capture work like middleware: gg.ts checks `globalThis.__ggFileSink` at module init and calls it directly. No transform hook, no code injection, no path matching.

### Desired State

- `curl http://localhost:5173/some-page` triggers SSR gg() calls → entries written to JSONL → `curl /__gg/logs` returns them. No browser needed.
- Browser visits also capture client-side entries (secondary, via `transformIndexHtml` + virtual module)
- Works for any consumer: simple project, monorepo, Tauri, pnpm/bun/npm

## Design

### Core Idea

The plugin already sets `globalThis.__ggFileSink` in `configureServer`. Currently this is only used by the (broken) transform-injected SSR code. The fix: make gg.ts itself check for this bridge and self-register.

```
Plugin (configureServer)              gg.ts (any module instance)
─────────────────────────             ──────────────────────────
globalThis.__ggFileSink = {           if (globalThis.__ggFileSink) {
    write(entry) {                        gg.addLogListener(entry => {
        serialize + appendFileSync            globalThis.__ggFileSink.write(entry);
    }                                     });
}                                     }
```

The plugin exposes a single `write(entry)` function that handles serialization and file I/O internally. gg.ts just calls it. No fs imports, no schema duplication.

### Server-Side Path (SSR + Agent Curl)

```
configureServer sets globalThis.__ggFileSink.write()
        ↓
gg.ts loads in SSR → sees globalThis.__ggFileSink → self-registers listener
        ↓
gg('hello') → _dispatchToListeners → write() → appendFileSync → .gg/logs-{port}.jsonl
        ↓
curl /__gg/logs → entries
```

### Client-Side Path (Browser)

```
transformIndexHtml injects <script type="module" src="/@id/virtual:gg-file-sink-sender">
        ↓
Virtual module loads (bypasses pre-bundling) → import { gg } from '@leftium/gg'
        ↓
gg.addLogListener → import.meta.hot.send('gg:log', ...) OR fetch POST fallback
        ↓
server.hot.on('gg:log') → appendEntry() → .gg/logs-{port}.jsonl
```

This part already exists in v53. The `transformIndexHtml` hook and virtual module are implemented. They just haven't been tested because the server-side path being broken made it seem like everything was broken.

## Design Decisions

| Decision                                                             | Choice                                                             | Rationale                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Server-side mechanism                                                | `globalThis.__ggFileSink.write()` called from gg.ts                | Same pattern as middleware — pure server-side. No transform hook, no path matching, no module identity issues. |
| Plugin exposes `write()` not raw `appendFileSync` + `serializeEntry` | Single function                                                    | Keeps serialization schema in one place. gg.ts doesn't need to know the JSONL format.                          |
| Client-side mechanism                                                | Keep existing `transformIndexHtml` + virtual module                | Already implemented in v53. Virtual modules bypass pre-bundling.                                               |
| Remove transform-based injection                                     | Yes, both SSR and browser branches                                 | Fundamentally broken for external deps. Source of all complexity.                                              |
| Guard in gg.ts                                                       | `globalThis.__ggFileSink` existence only, no `import.meta.env.DEV` | The bridge only exists when the plugin sets it during dev. No need to couple gg.ts to Vite.                    |

## Implementation Plan

### Phase 1: gg.ts Self-Registration

- [ ] **1.1** In `configureServer`, change `globalThis.__ggFileSink` to expose a `write(entry: CapturedEntry, env: string)` function that serializes and appends in one call. Keep the `logFile` getter for the SSR injection fallback during transition.
- [ ] **1.2** At the end of gg.ts module init (after `addLogListener` is defined, ~line 1408), add:
  ```ts
  if (typeof globalThis !== 'undefined' && globalThis.__ggFileSink?.write) {
  	gg.addLogListener((entry) => globalThis.__ggFileSink.write(entry, 'server'));
  }
  ```
- [ ] **1.3** Remove the `transform` hook entirely (both SSR and browser injection branches).
- [ ] **1.4** Remove `ggModulePath` resolution in `configResolved`.

### Phase 2: Build, Pack, Test in kit-demos

- [ ] **2.1** Build and pack the updated gg package.
- [ ] **2.2** Install in `/Volumes/p/kit-demos` with pnpm.
- [ ] **2.3** `curl http://localhost:5173/` then `curl /__gg/logs` — expect SSR entries.
- [ ] **2.4** Open in browser, check for client-side entries (tests `transformIndexHtml` path).

### Phase 3: Test in epicenter

- [ ] **3.1** Install updated gg in epicenter.
- [ ] **3.2** Verify SSR + browser/Tauri entries.

## Edge Cases

### Multiple gg Instances (Plugin vs SSR)

The plugin's gg instance and the SSR gg instance are different objects. Both will self-register via `globalThis.__ggFileSink.write()`. This means some entries may be written twice (once from each instance). Mitigation: the plugin's `configureServer` listener (`gg.addLogListener(serverSideListener)`) captures entries from its own instance. The self-registration in gg.ts captures entries from the SSR instance. The dedup logic in `/__gg/logs` already handles duplicates.

### gg.ts Loads Before configureServer

During cold start, `configureServer` runs before any SSR module loads — `globalThis.__ggFileSink` is set first. If somehow gg.ts loads earlier (shouldn't happen), the check fails silently. The `earlyLogBuffer` preserves entries, and a late-registering listener would replay them — but that requires the listener to register eventually. Acceptable risk; Vite's lifecycle guarantees `configureServer` runs during plugin init, before any module resolution.

### gg.ts in Non-Vite Context

`globalThis.__ggFileSink` won't exist → check fails → no listener registered. Correct behavior.

### SvelteKit and transformIndexHtml

SvelteKit may not run Vite's `transformIndexHtml` during dev (it renders HTML server-side). If the `<script>` tag doesn't appear, client-side capture won't work. This is a Phase 2/3 finding — if it fails, add response-intercepting middleware. Server-side capture (the primary use case for agents) is unaffected.

## Success Criteria

- [ ] `pnpm add @leftium/gg` in kit-demos → `curl` a page → `curl /__gg/logs` returns SSR entries (no browser)
- [ ] Browser visit adds client-side entries
- [ ] Works in epicenter (bun, monorepo, Tauri)
- [ ] gg's own demo app still works (regression)
- [ ] No console errors about missing modules

## References

- `src/lib/gg-file-sink-plugin.ts` — Plugin: expose `write()` on globalThis, remove `transform` hook
- `src/lib/gg.ts` — Core module: add self-registration at ~line 1408
- `/Volumes/p/kit-demos/` — Test project (simple SvelteKit + pnpm)
- `/Volumes/p/epicenter/` — Target project (monorepo + Tauri + bun)
