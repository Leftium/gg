# Two-Layer Filtering for gg Console

## Overview

Replace the current single-layer display filter with a two-layer filtering strategy that gives users control over both **what enters the ring buffer** and **what is displayed** from it. This addresses the problem of high-volume logging overwhelming the ring buffer's fixed capacity (default: 2000 loggs).

> **Terminology:** gg calls its log messages "loggs" (double-g). This branding is used consistently in UI text, code, and documentation.

This spec also breaks from the `debug` npm package conventions. gg's internal debug implementation (which replaced the `debug` package) will use its own naming and storage conventions going forward.

## Motivation

1. **Ring buffer overflow.** With many active namespaces, the 2000-logg buffer fills quickly. Important loggs get evicted by noisy namespaces. Currently the only mitigation is increasing buffer size, which costs memory.
2. **No capture-time control.** Today, all `gg()` calls enter the ring buffer regardless of the display filter (`gg-filter`). The display filter only hides loggs after they've already consumed buffer slots.
3. **Simpler mental model.** The current system has three overlapping controls: `GG_ENABLED` (on/off gate), `localStorage.debug` (native console output), and `gg-filter` (panel display). This consolidates to two clear layers with distinct purposes.
4. **Breaking from `debug` package.** gg no longer depends on the `debug` npm package (it's a full internal rewrite). Sharing `localStorage.debug` causes conflicts when users also use the `debug` package in the same project -- both read the same key but control different things.

## Current State (Before)

```
gg() call ──► GG_ENABLED gate ──► Ring Buffer (2000) ──► gg-filter ──► Panel Display
                                          │
                                          └──► localStorage.debug ──► Native Console
```

- `GG_ENABLED` / `VITE_GG_ENABLED`: binary on/off for all gg functionality
- `localStorage.debug`: controls native console output (shared key with `debug` npm package)
- `localStorage['gg-filter']`: controls GG panel display (default: `gg:*`)
- All loggs that pass the `GG_ENABLED` gate enter the ring buffer

## Proposed State (After)

```
gg() call ──► GG_ENABLED gate ──► gg-keep ──► Ring Buffer (2000) ──► gg-show ──► Panel
                                      │                                   │
                                      │                                   └──► Native Console
                                      │                                        (when gg-console
                                      │                                         is enabled)
                                      ▼
                                 Dropped NS Tracker
                                 (outside buffer)
```

### Layer 1: Keep Gate (`gg-keep`)

Controls which namespaces have their loggs kept in the ring buffer.

| Environment | Setting                   | Default               |
| ----------- | ------------------------- | --------------------- |
| Browser     | `localStorage['gg-keep']` | `*` (keep everything) |
| Server      | `GG_KEEP` env var         | `*` (keep everything) |

When a namespace is **not** matched by `gg-keep`:

- The logg is dropped (not added to the ring buffer)
- A count is incremented in the Dropped Namespace Tracker (see below)
- A one-time sentinel entry is created for that namespace (see below)

**Default `*` rationale:** gg's core value is frictionless debugging. The keep gate is off by default (pass-through). Users who hit buffer limits narrow it explicitly. This diverges from the `debug` package convention (where unset = nothing enabled) but preserves gg's zero-config experience.

### Layer 2: Show Filter (`gg-show`)

Controls which kept loggs are shown in the GG panel and optionally the native console.

| Environment | Setting                   | Default               |
| ----------- | ------------------------- | --------------------- |
| Browser     | `localStorage['gg-show']` | `*` (show everything) |
| Server      | N/A                       | N/A                   |

This is a rename of the current `gg-filter` to better describe its purpose (what to show, not the mechanism of filtering).

### Native Console Toggle (`gg-console`)

Controls whether shown loggs are also output to the native browser console.

| Environment | Setting                          | Default           |
| ----------- | -------------------------------- | ----------------- |
| Browser     | `localStorage['gg-console']`     | `true`            |
| Server      | N/A (console is the only output) | Follows `GG_KEEP` |

**Default `true` rationale:** `gg()` is designed to be useful without the Eruda widget. Console output is the baseline experience -- the proof that `gg()` is doing something. The Eruda widget is an optional upgrade, not a requirement. Zero-config means it works out of the box.

When the Eruda plugin initializes, it flips `gg-console` to `false` automatically -- but only if `localStorage['gg-console']` has not been explicitly set by the user. This way, users who want both console output and the widget can have both by setting `localStorage['gg-console'] = 'true'` manually.

**Disabling console output** (if the noise is unwanted):

```js
// In DevTools console, or in your app's init code:
localStorage['gg-console'] = 'false';
```

Or via the Settings panel in the Eruda widget (toggle: "Native console output").

When enabled, native console output follows the `gg-show` filter -- the console shows exactly what the panel shows. When `gg-show` changes (e.g., via the panel UI), the debug instances are immediately re-evaluated so console output updates without a reload.

This eliminates the need for the current "Sync" button in Settings that copies `gg-filter` to `localStorage.debug`.

## Dropping the `gg:` Namespace Prefix

Currently all namespaces are prefixed with `gg:` (e.g., `gg:routes/+page.svelte@handleClick`). This was necessary because `localStorage.debug` is shared with the `debug` npm package -- the prefix distinguishes gg namespaces from Express, Socket.io, etc.

With gg using its own dedicated storage keys, this disambiguation is no longer needed. Namespaces become shorter and cleaner:

| Before                               | After                             |
| ------------------------------------ | --------------------------------- |
| `gg:routes/+page.svelte@handleClick` | `routes/+page.svelte@handleClick` |
| `gg:lib/util.ts@calculate`           | `lib/util.ts@calculate`           |
| `gg:api:auth`                        | `api:auth`                        |

Benefits:

- More screen real estate in the namespace column
- Cleaner custom namespaces
- Default filters become `*` instead of `gg:*`

The `gg:` prefix may still appear in native console output (as a visual signal that a line comes from gg), but it would not be part of the stored namespace.

## Dropped Namespace Tracking

Loggs dropped by the keep gate are tracked **outside** the ring buffer in a dedicated data structure:

```typescript
interface DroppedNamespaceInfo {
	namespace: string;
	firstSeen: number; // timestamp of first dropped logg
	lastSeen: number; // timestamp of most recent dropped logg
	total: number; // total dropped logg count
	byType: Record<string, number>; // count per logg type (log, warn, error, etc.)
	preview: CapturedEntry; // most recent dropped logg, for preview in sentinel
}
```

This map does not consume ring buffer slots. It grows with the number of distinct dropped namespaces, which is expected to be small (tens, not thousands). The `preview` field stores the **most recent** dropped logg per namespace (overwritten on each drop -- just a reference swap, negligible cost) so users can see what a namespace is producing _right now_ before deciding whether to keep it.

## Sentinel Entries for Dropped Namespaces

For each namespace blocked by `gg-keep`, a **one-time sentinel entry** is rendered in the GG panel. These sentinels:

1. Use the prefix `DROPPED:` before the namespace (e.g., `DROPPED:routes/+page.svelte@handleClick`)
2. Are **not stored in the ring buffer** -- they are rendered from the `droppedNamespaces` map
3. Show the count of dropped loggs (total and per-type if available)
4. Show a preview of the most recent dropped logg so users can assess the namespace's current output
5. Include a `[+]` keep icon to add this namespace to `gg-keep`
6. Can be filtered as a group using `DROPPED:*` in the show filter

### Sentinel Positioning: Fixed at Top

Dropped sentinels are rendered in a **fixed section at the top** of the log view, above the scrolling logg list. They do not interleave with regular loggs and do not reposition as new loggs arrive.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Keep: [api:*,auth:*___________________] [Namespaces: 5/12]                 │
│ Show: [*______________________________] [Namespaces: 10/12]                │
├─────────────────────────────────────────────────────────────────────────────┤
│ [+]  DROPPED:routes/+page.svelte@handleClick  47 loggs (32 log, 15 warn)  │
│        ↳ "Processing item: {id: 42, name: ...}"                           │
│ [+]  DROPPED:lib/analytics.ts@track           203 loggs (203 log)         │
│        ↳ "pageview: /dashboard"                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ +2ms   api/users@fetchAll       [{id: 1, ...}, {id: 2, ...}]             │
│ +5ms   auth/session@validate    token valid, expires in 3600s             │
│ +12ms  api/users@fetchAll       cache miss, querying DB                   │
│ ...                                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Rationale:** Fixed-at-top ensures sentinels are always visible and never scrolled past. Since `gg-keep` defaults to `*` and users only narrow it intentionally, the number of dropped namespaces is small (typically 1-5). The fixed section doesn't consume significant viewport space.

**Sort order:** Sentinels are sorted by **decreasing logg count** (noisiest namespace first). This puts the biggest buffer-pressure offenders at the top, making it easy to identify and keep/drop the most impactful namespaces. The sort order updates on each debounced render cycle.

**Update behavior:** Only the sentinel's text content updates (count + preview). Count and preview updates are debounced (e.g., every 250ms or on next `requestAnimationFrame`) to avoid thrashing when a noisy namespace is rapidly dropping loggs. Re-sorting on each debounced update is cheap (typically 1-5 sentinels).

### Sentinel Entry UI

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [+]  DROPPED:routes/+page.svelte@handleClick  47 loggs (32 log, 15 warn)   │
│        ↳ "Processing item: {id: 42, name: ...}"                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- The entire sentinel is rendered in **muted gray** -- text, namespace, counts, and preview all share the same desaturated color. This visually distinguishes dropped sentinels from regular loggs at a glance and reinforces that these are informational placeholders, not actual logged data. All dropped sentinels use the same gray regardless of what color the namespace would normally have.
- The `[+]` icon is the visual inverse of the `[x]` hide icon on regular loggs
- The namespace segments are clickable for filtering (clicking `DROPPED:` filters to all dropped sentinels)
- The count updates in real-time (debounced) as more loggs are dropped
- The preview line shows a truncated version of the most recent dropped logg

### Per-Logg Row Actions (Three Icons)

Each regular logg row has two action icons. Dropped sentinels have one. The three icons across the system are:

```
Regular logg row:
┌──────────────────────────────────────────────────────────────────┐
│ [x] [-]  +5ms  api/users@fetchAll  [{id: 1, ...}, {id: 2, ...}]│
└──────────────────────────────────────────────────────────────────┘

Dropped sentinel:
┌──────────────────────────────────────────────────────────────────┐
│ [+]  DROPPED:api/analytics@track  203 loggs (203 log)           │
│        ↳ "pageview: /dashboard"                                 │
└──────────────────────────────────────────────────────────────────┘
```

| Icon  | Action   | Layer               | Appears on        | Effect                                                                                                                                             |
| ----- | -------- | ------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[x]` | **Hide** | `gg-show` (display) | Regular loggs     | Loggs still enter buffer, just not shown. Fully reversible -- unhide and all loggs reappear.                                                       |
| `[-]` | **Drop** | `gg-keep` (buffer)  | Regular loggs     | Loggs stop entering buffer entirely. Stronger than hide -- future loggs from this NS are lost until re-kept. Namespace becomes a dropped sentinel. |
| `[+]` | **Keep** | `gg-keep` (buffer)  | Dropped sentinels | Start keeping loggs from a dropped NS. Only new loggs from this point forward.                                                                     |

All three icons trigger a toast with segment-level granularity (see toast sections below).

### Keep Toast (Segment-Level Keep Control)

Clicking the `[+]` keep icon on a sentinel triggers a **keep toast** -- a toast bar that mirrors the existing hide toast pattern but works in the opposite direction (include instead of exclude).

#### How it works

1. User clicks `[+]` on a sentinel for `DROPPED:routes/+page.svelte@handleClick`
2. A toast bar appears at the bottom of the panel:

```
┌──────────────────────────────────────────────────────────────────┐
│ [×]  Keep: [routes] / [+page.svelte] @ [handleClick]  [Undo] [?] │
│      Click a segment to keep all matching namespaces               │
└──────────────────────────────────────────────────────────────────┘
```

3. The namespace is split into clickable segments using the same delimiter logic as the hide toast (`:/@ -_`)
4. Each segment builds a progressive glob pattern:

| Click target   | Pattern added to `gg-keep`        | Effect                                  |
| -------------- | --------------------------------- | --------------------------------------- |
| `routes`       | `routes/*`                        | Keep all loggs from `routes/` and below |
| `+page.svelte` | `routes/+page.svelte*`            | Keep all loggs from this file           |
| `handleClick`  | `routes/+page.svelte@handleClick` | Keep only this exact namespace          |

5. Clicking a segment adds the corresponding pattern to `gg-keep` and takes effect immediately
6. New loggs from matching namespaces enter the buffer going forward (previously dropped loggs are lost, except the preview which is already visible)

#### Toast anatomy

See the [full toast comparison table](#toast-anatomy-mirrors-hide-and-keep-toasts) in the Drop Toast section below for a side-by-side of all three toasts.

#### Interaction detail

- **Left-click segment:** Add the segment's glob pattern to `gg-keep`. If `gg-keep` was previously restrictive (e.g., `api:*`), the new pattern is appended: `api:*,routes/*`.
- **Undo:** Restores the previous `gg-keep` value (stored before the keep action, same pattern as `lastHiddenPattern` in the hide toast).
- **Dismiss:** Closes the toast without making changes.
- Only one toast (hide, drop, or keep) is visible at a time. Showing any toast dismisses any other visible toast.

#### Changes take effect instantly (no reload)

Changing `gg-keep` takes effect immediately -- no page reload required. The keep gate pattern is re-parsed on update, and the very next `gg()` call evaluates against the new pattern. This uses the same lazy-invalidation mechanism as the existing debug factory (`common.ts:209-223`): each namespace's enabled state is cached and automatically re-evaluated when the pattern changes.

**Limitation:** Previously dropped loggs are lost. Only new loggs from the newly-kept namespace will enter the buffer. The sentinel's preview (first dropped logg) remains visible until the sentinel is dismissed or the namespace accumulates real buffer loggs.

The sentinel for a newly-kept namespace transitions naturally: once new loggs start arriving in the buffer, they appear as regular loggs. The sentinel itself remains visible (showing the historical drop count) until the user clears the dropped namespace tracker or reloads the page.

### Drop Toast (Segment-Level Drop Control)

Clicking the `[-]` drop icon on a regular logg triggers a **drop toast** -- a toast bar that adds an exclusion to `gg-keep`, preventing the namespace's loggs from entering the ring buffer.

#### How it works

1. User clicks `[-]` on a logg from `api/analytics.ts@track`
2. A toast bar appears at the bottom of the panel:

```
┌──────────────────────────────────────────────────────────────────┐
│ [×]  Drop: [api] / [analytics.ts] @ [track]            [Undo] [?] │
│      Click a segment to drop all matching namespaces                │
└──────────────────────────────────────────────────────────────────┘
```

3. The namespace is split into clickable segments using the same delimiter logic as the other toasts
4. Each segment builds a progressive exclusion pattern:

| Click target   | Pattern added to `gg-keep` | Effect                               |
| -------------- | -------------------------- | ------------------------------------ |
| `api`          | `-api/*`                   | Drop all loggs from `api/` and below |
| `analytics.ts` | `-api/analytics.ts*`       | Drop all loggs from this file        |
| `track`        | `-api/analytics.ts@track`  | Drop only this exact namespace       |

5. Clicking a segment adds the exclusion to `gg-keep` and takes effect immediately
6. Existing loggs from the namespace remain in the buffer (they were already kept). Only future loggs are dropped.
7. A dropped sentinel appears in the fixed-at-top section for the newly dropped namespace

#### Toast anatomy (mirrors hide and keep toasts)

| Element                 | Hide toast                                                  | Drop toast (new)                                                  | Keep toast                                                 |
| ----------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Label                   | `Hidden:`                                                   | `Drop:`                                                           | `Keep:`                                                    |
| Segments                | Clickable, each adds an exclusion (`-pattern`) to `gg-show` | Clickable, each adds an exclusion (`-pattern`) to `gg-keep`       | Clickable, each adds an inclusion (`pattern`) to `gg-keep` |
| Undo                    | Restores previous `gg-show`                                 | Restores previous `gg-keep`                                       | Restores previous `gg-keep`                                |
| Help `?`                | "Click a segment to hide all matching namespaces"           | "Click a segment to drop all matching namespaces from the buffer" | "Click a segment to keep all matching namespaces"          |
| Dismiss `×`             | Closes toast                                                | Closes toast                                                      | Closes toast                                               |
| Auto-expand explanation | On first use                                                | On first use (independent flag)                                   | On first use (independent flag)                            |

#### Interaction detail

- **Left-click segment:** Add the segment's exclusion pattern to `gg-keep`. E.g., if `gg-keep` was `*`, it becomes `*,-api/*`.
- **Undo:** Restores the previous `gg-keep` value.
- **Dismiss:** Closes the toast without making changes.
- Only one toast (hide, drop, or keep) is visible at a time.

### Filtering Dropped Sentinels

- `gg-show = '*'` -- shows both kept loggs and dropped sentinels
- `gg-show = 'DROPPED:*'` -- shows only dropped sentinels (useful for reviewing what's being dropped)
- `gg-show = '*,-DROPPED:*'` -- hides all dropped sentinels (clean view of kept loggs only)
- `gg-show = 'DROPPED:api:*'` -- shows only dropped sentinels from api namespaces

## Migration from Current Settings

No migration logic. Clean break. The old keys (`gg-filter`, `debug`) will be ignored. Users (currently ~2) can clear them manually or they'll sit harmlessly in localStorage.

| Old Key                          | Disposition                                                       |
| -------------------------------- | ----------------------------------------------------------------- |
| `localStorage['gg-filter']`      | Ignored. Replaced by `gg-show`.                                   |
| `localStorage['debug']`          | Ignored by gg. Remains undisturbed for `debug` npm package users. |
| `GG_ENABLED` / `VITE_GG_ENABLED` | Unchanged. Binary on/off gate remains as-is.                      |

## Summary of All Settings

### Browser (localStorage)

| Key                   | Type         | Default       | Purpose                                           |
| --------------------- | ------------ | ------------- | ------------------------------------------------- |
| `gg-enabled`          | boolean      | `true` in dev | Production activation flag (unchanged)            |
| `gg-keep`             | glob pattern | `*`           | Layer 1: which loggs enter the ring buffer        |
| `gg-show`             | glob pattern | `*`           | Layer 2: which loggs are shown in panel + console |
| `gg-console`          | boolean      | `true`        | Whether shown loggs also go to native console     |
| `gg-show-expressions` | boolean      | `true`        | Expression visibility (unchanged)                 |
| `gg-ns-action`        | string       | `'open'`      | Namespace click action (unchanged)                |
| `gg-editor-bin`       | string       | `''`          | Editor binary for open-in-editor (unchanged)      |
| `gg-copy-format`      | string       | `''`          | Copy format template (unchanged)                  |
| `gg-url-format`       | string       | `''`          | URL format template (unchanged)                   |
| `gg-project-root`     | string       | `''`          | Project root path (unchanged)                     |

### Server (environment variables)

| Variable                         | Type         | Default       | Purpose                                                         |
| -------------------------------- | ------------ | ------------- | --------------------------------------------------------------- |
| `GG_ENABLED` / `VITE_GG_ENABLED` | boolean      | `true` in dev | Binary on/off gate (unchanged)                                  |
| `GG_KEEP`                        | glob pattern | `*`           | Which loggs enter the ring buffer (server console follows this) |

### Removed

| Old Setting                           | Reason                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `localStorage['debug']`               | Replaced by `gg-show` + `gg-console`. No longer conflicts with `debug` npm package. |
| `process.env.DEBUG` (for gg purposes) | Replaced by `GG_KEEP`. `DEBUG` still works for the `debug` npm package if present.  |
| Settings "Sync" button                | Unnecessary -- native console output now follows `gg-show` automatically.           |

## UI Changes

### Truncation Banner Update

The existing banner at the top of the log view currently shows:

```
⚠ Showing N of M messages -- X truncated. Increase maxEntries to retain more.
```

It is purely informational (no click handlers). It should be updated to include dropped counts and become **clickable** to open the Keep namespace panel:

```
⚠ Showing N of M kept -- X evicted, Y dropped (Z namespaces). Adjust keep filter →
```

Where:

- N = shown loggs (after `gg-show` filter)
- M = total loggs in ring buffer
- X = loggs evicted from the ring buffer (oldest overwritten)
- Y = total loggs dropped by `gg-keep`
- Z = number of distinct dropped namespaces

**Click action:** Clicking anywhere on the banner opens the **Keep namespace panel** (the `gg-keep` checkbox panel), sorted by buffer count descending. This puts the noisiest kept namespaces at the top, making it easy to identify and drop the biggest buffer consumers. The banner uses a pointer cursor to signal interactivity. The "Adjust keep filter" trailing text reinforces that the banner is actionable.

The banner only appears when eviction is happening (X > 0) or when loggs are being dropped (Y > 0). When both are 0, the banner is hidden (same as current behavior).

### Empty State

When the GG console is empty (no loggs captured), show a helpful prompt:

```
No loggs kept.

[Keep All]  Sets gg-keep to * (keep all namespaces)

gg-keep: <current value>
gg-show: <current value>
```

If `gg-keep` is already `*` and the console is still empty, the issue is elsewhere (gg not enabled, no gg() calls, etc.) -- fall back to the existing diagnostics.

### Toolbar Layout

The toolbar area (above the log view) should show both filter controls, following the data flow order:

```
┌─────────────────────────────────────────────────────────────┐
│ Keep: [*____________________________] [Namespaces: 5/12]   │
│ Show: [*,-api:verbose:*_____________] [Namespaces: 10/12]  │
└─────────────────────────────────────────────────────────────┘
```

- **Keep** (`gg-keep`): text input with the current keep gate pattern. Above show because data flows through it first.
- **Show** (`gg-show`): text input with the current show filter pattern. Replaces the current filter input.
- Each has its own namespace count button that expands to show checkboxes (same as existing filter panel behavior).

### Settings Panel

Update the Settings panel to show:

- **Native console output** (`gg-console`): toggle, default on. Replaces the current Sync/Clear buttons and `localStorage.debug` display. The Eruda plugin turns this off automatically on init (unless the user has explicitly set it).
- **Diagnostics hint** when `gg-console` is on: "Native console output is enabled. Disable to silence gg loggs in DevTools console."

### Filter Panel (Namespace Checkboxes)

The existing filter panel (toolbar button showing `Namespaces: N/M`) is split into two:

- **Keep namespaces panel** (for `gg-keep`): checkboxes for all discovered namespaces. Unchecked = loggs not kept in buffer. Shows dropped sentinels inline.
- **Show namespaces panel** (for `gg-show`): checkboxes for kept namespaces only. Same behavior as the current filter panel.

Both panels follow the existing UI patterns (top 5 most frequent, "ALL" checkbox, "other" checkbox, complex pattern warning).

## Implementation Phases

The spec is split into three phases to allow incremental delivery. Each phase is independently mergeable.

### Phase 1 — Core mechanics (unblocks file sink) [x]

Changes to `gg.ts`, `debug/browser.ts`, `debug/node.ts`, and `plugin.ts` internals. No new UI elements.

- [x] **`_onLog` multi-listener** — converted from a single `OnLogCallback | null` slot to a `Set<OnLogCallback>`. New API: `gg.addLogListener(fn)` / `gg.removeLogListener(fn)`. The `_onLog` setter remains as a backward-compatible single-slot alias. Early-buffer replay fires on first listener registration. Eruda plugin updated to use `addLogListener`/`removeLogListener` with legacy fallback.
- [x] **Drop `gg:` prefix** — removed the `gg:` prefix from all generated namespaces in `gg.ts` (`ggLog()`, `gg.here()`, `gg._here()`). Namespace construction is now `nsLabel` directly instead of `` `gg:${nsLabel}` ``. Console padding in `createGgDebugger` updated. Diagnostics updated to reference `GG_KEEP` instead of `DEBUG=gg:*`.
- [x] **Rename `gg-filter` → `gg-show`** — renamed the localStorage key (`SHOW_KEY = 'gg-show'`), all variable names. Legacy `gg-filter` key is read as fallback on init (no migration needed). Default pattern updated from `'gg:*'` to `'*'`. Placeholder text and `isSimplePattern()` updated.
- [x] **Add `gg-keep` layer** — `keepPattern` variable loaded from `localStorage['gg-keep']` (default `'*'`). Applied in `onEntry` handler before `buffer.push()`: loggs not matching `keepPattern` are dropped (counted but not stored). `debug/node.ts` updated to use `GG_KEEP` env var instead of `DEBUG`; defaults to `'*'` (zero-config). `debug/browser.ts` updated to use `gg-show` key.
- [x] **Add `gg-console` toggle** — removed `localStorage.debug` usage from `debug/browser.ts` (now uses `gg-console` + `gg-show`). Eruda plugin flips `gg-console` to `false` on init if not explicitly set. Settings panel Sync/Clear buttons replaced with a single "Native console output" checkbox. Debug factory re-enabled with correct pattern on toggle change.

### Phase 2 — Dropped namespace tracking [ ]

Data layer only. The tracker is wired up but sentinels are not yet rendered in the UI.

- [ ] **`DroppedNamespaceInfo` map** — maintained outside the ring buffer in `plugin.ts`. Updated by the `gg-keep` gate on each dropped logg.
- [ ] **Sentinel data available** — `getDroppedNamespaces()` returns the map for consumers (file sink, future UI).

### Phase 3 — Full UI [ ]

All UI changes described in the spec.

- [ ] **New toolbar** — two rows: Keep filter input + "Namespaces: N/M" button; Show filter input + "Namespaces: N/M" button.
- [ ] **Dropped sentinel section** — fixed-at-top section showing `DROPPED:ns` rows with `[+]` keep icon, count, and preview. Debounced updates.
- [ ] **Per-logg icons** — `[x]` hide (existing, now targets `gg-show`), `[-]` drop (new, targets `gg-keep`). Dropped sentinels show `[+]` keep icon.
- [ ] **Drop/Keep toasts** — segment-level control toasts mirroring existing hide toast.
- [ ] **Truncation banner update** — include dropped counts; clickable to open Keep namespace panel.
- [ ] **Empty state update** — show `[Keep All]` button when `gg-keep` is restrictive and buffer is empty.
- [ ] **Settings panel update** — remove Sync/Clear buttons and `localStorage.debug` display; add `gg-console` toggle.
- [ ] **Keep namespace panel** — separate checkbox panel for `gg-keep` (split from existing filter panel which becomes `gg-show` only).

---

## Open Questions

1. **`GG_ENABLED` / `VITE_GG_ENABLED` unification.** These exist as separate env vars due to Vite's `VITE_` prefix requirement for client-side exposure. Could the gg Vite plugin alias `GG_ENABLED` to `VITE_GG_ENABLED` automatically, so users only set one variable? This is orthogonal to the filtering proposal but worth addressing.

2. **`gg-console` as string filter.** Currently specified as a boolean. Could be upgraded to a glob pattern string for per-namespace console output control. Boolean is simpler for v1; string filter could be added later if needed (backward compatible: `'true'`/`'false'` still work as boolean, any other string is treated as a glob pattern).

## Resolved Questions

1. **~~`gg:` prefix in native console output.~~** No. The ms diff + colored namespace output is already visually distinct. The `gg:` prefix is dropped entirely (see "Dropping the `gg:` Namespace Prefix" section).

2. **~~Retroactive save.~~** No secondary buffer. Instead, the sentinel shows a preview of the first dropped logg so users can assess what a namespace produces before deciding to keep it. This is simpler and sufficient.

3. **~~Keep gate UI control placement.~~** Above `gg-show` in the toolbar area, following the data flow (keep gate first, then show filter). Both are accessible from the main UI, not buried in Settings.

4. **~~Migration logic.~~** None. Clean break. ~2 users can clear old localStorage keys manually.

5. **~~`gg-console` default.~~** `true`. `gg()` is useful without the Eruda widget; console output is the baseline experience. The Eruda plugin flips it to `false` on init if the user hasn't explicitly set it. Users who want both can set `localStorage['gg-console'] = 'true'` to override.

6. **~~Sentinel positioning.~~** Fixed at top of the log view. Sentinels don't interleave with regular loggs and don't reposition as new loggs arrive. Count and preview updates are debounced. Alternative positions considered: fixed at bottom, inline at first occurrence, inline repositioned on each drop, collapsible section.

7. **~~Sentinel preview.~~** Shows the **most recent** dropped logg (overwritten on each drop). More useful than the first logg because it shows what the namespace is producing _right now_. Cost is negligible (reference swap on each drop, debounced re-render).

8. **~~Drop action from regular loggs.~~** Users can drop a namespace directly from a regular logg row via the `[-]` icon. This triggers a drop toast with segment-level granularity, mirroring the hide and keep toasts. Three icons total: `[x]` hide, `[-]` drop, `[+]` keep.

9. **~~Buffer pressure discovery.~~** Clicking the truncation banner opens the Keep namespace panel sorted by buffer count descending. No new UI -- just wiring the existing banner to the existing panel. The banner text includes "Adjust keep filter" to signal interactivity.

10. **~~Naming.~~** `gg-keep` / `DROPPED:` / `gg-show`. Other candidates explored:

| Layer 1 (buffer gate) | Sentinel prefix | Layer 2 (panel + console) |
| --------------------- | --------------- | ------------------------- |
| **`gg-keep`**         | **`DROPPED:`**  | **`gg-show`**             |
| `gg-saved`            | `UNSAVED:`      | `gg-display`              |
| `gg-allow`            | `BLOCKED:`      | `gg-display`              |
| `gg-accept`           | `REJECTED:`     | `gg-display`              |
| `gg-included`         | `EXCLUDED:`     | `gg-display`              |
| `gg-listen`           | `MUTED:`        | `gg-display`              |
| `gg-record`           | `UNRECORDED:`   | `gg-display`              |

## References

- [gg-widget spec](./gg-widget.md) -- Eruda plugin architecture that this spec builds on
- Ring buffer implementation: `src/lib/eruda/buffer.ts`
- Current filter logic: `src/lib/eruda/plugin.ts` (lines 398-460, `namespaceMatchesPattern`)
- Internal debug implementation: `src/lib/debug/common.ts`, `browser.ts`, `node.ts`
