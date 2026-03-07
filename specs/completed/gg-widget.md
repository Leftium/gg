# gg.widget: Eruda Plugin for Mobile Debugging

> **Status: Implemented.** All core functionality is complete. The `localStorage.debug` manager approach was superseded by two-layer filtering (`gg-keep`/`gg-show`). Namespace presets (All/Routes/Lib/Off) were deferred indefinitely — the Keep/Show checkbox panels cover this use case. See [gg-two-layer-filtering.md](./completed/gg-two-layer-filtering.md) for the filtering implementation.

## Overview

Add a `gg` tab to [Eruda](https://github.com/liriliri/eruda) (mobile debug console) that provides namespace-aware filtering, `localStorage.debug` management, and clipboard copy for `gg()` output. Eruda handles the floating button, panel chrome, JS execution, and general DevTools features. The gg plugin focuses exclusively on what Eruda's built-in Console tab can't do.

For more involved remote debugging from a desktop, see the [Chii companion tool](#chii-companion-tool-remote-desktop-debugging) section.

This feature **supersedes** the `gg.persist` spec. Instead of requiring a separate `ggg()` call to capture output, the plugin automatically intercepts all `gg()` calls - zero API changes needed.

## Motivation

1. **Mobile debugging is painful.** Android and iOS don't expose `console.debug` output without connecting to a desktop machine. Eruda provides a full on-device console, and the gg plugin adds namespace-aware features on top.
2. **No code changes required.** Unlike `gg.persist`, users don't need to switch from `gg()` to `ggg()`. Just add the plugin and all existing `gg()` calls are captured.
3. **`localStorage.debug` is hard to manage.** Currently requires typing `localStorage.debug = 'gg:*'` in DevTools. The plugin provides a UI for this.
4. **Eruda already solves 80% of the problem.** Its Console tab already renders `gg()` output with `%c` CSS formatting correctly. It already has JS execution, Network, Elements, Storage panels. Building a standalone widget would mean reimplementing all of that.

## What Eruda Provides (Free)

These features come from Eruda itself - no plugin code needed:

- **Floating button** - draggable, positioned at screen edge
- **Panel chrome** - tabs, resizing, open/close
- **Console tab** - all `console.*` output including `gg()` with CSS formatting, JS execution input
- **Network tab** - XHR, Fetch, sendBeacon requests
- **Elements tab** - live HTML tree
- **Resources tab** - Cookies, localStorage, sessionStorage viewer/editor
- **Sources tab** - HTML/JS/CSS source viewer
- **Info tab** - URL, user agent, screen size
- **Snippets tab** - saved JS commands
- **Dark/light theme**

## What the gg Plugin Adds

Features specific to `gg` that Eruda's Console tab doesn't provide:

### 1. Namespace-Aware Log Filtering

Eruda's Console tab can only filter by log level (All/Info/Warning/Error). The gg plugin adds filtering by `debug` namespace using wildcard patterns:

```
┌─────────────────────────────────────┐
│ gg                                  │
├─────────────────────────────────────┤
│ 🔍 [*:wmo____________________] [⟳] │
│ ┌─────────────────────────────────┐ │
│ │ +2ms  gg:routes/+page:wmo  code=3 │ │
│ │ +5ms  gg:lib/util:wmo  grouped: 3 │ │
│ │ +12ms gg:routes/+page:wmo  done   │ │
│ │                                 │ │
│ └─────────────────────────────────┘ │
│ [📋 Copy] [🗑 Clear] [⏸ Pause]     │
│ 3 of 47 entries (filter: *:wmo)     │
└─────────────────────────────────────┘
```

- **Wildcard filter input** - uses `debug` library's matching syntax (`*`, `gg:routes/*`, `*:wmo`, `*@handleClick*`)
- **Auto-scroll** to latest entry (with "jump to bottom" when scrolled up)
- **Tap to expand** an entry to see full object/value
- **Pause/resume** - freeze current view while app continues logging
- **Copy** - copies visible (filtered) logs via `navigator.clipboard.writeText()`
- **Clear** - empties the capture buffer

### 2. `localStorage.debug` Namespace Manager

> **Superseded.** The Sync/Clear buttons were removed. `localStorage.debug` is no longer used by gg. The [two-layer filtering spec](./completed/gg-two-layer-filtering.md) replaced this with `gg-keep` (buffer gate) and `gg-show` (display filter). The Settings panel now has a single `gg-console` toggle for native console output.

```
┌─────────────────────────────────────┐
│ localStorage.debug: [gg:*_________] │
│                          [💾 Apply] │
│                                     │
│ Discovered namespaces:              │
│ ┌─────────────────────────────────┐ │
│ │ [✅] gg:*            (all)     │ │
│ │ [✅] gg:routes/*     (routes)  │ │
│ │ [  ] gg:lib/*        (lib)     │ │
│ │ [✅] gg:*@handleClick          │ │
│ │ [  ] gg:*:wmo        (extend)  │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Presets: [All] [Routes] [Lib] [Off] │
└─────────────────────────────────────┘
```

- **Direct edit** of `localStorage.debug` value
- **Auto-discovered namespaces** - as `gg()` calls come in, their namespaces populate the toggle list
- **Quick toggle** checkboxes that compose the `localStorage.debug` string
- **Apply** calls `gg.enable()` / `gg.disable()` to take effect immediately (no page reload needed)
- **Presets** for common patterns

### 3. Copy Filtered Logs

The key feature from `gg.persist` that Eruda's Console doesn't offer:

- Copy only `gg()` output (not React warnings, third-party library noise, etc.)
- Copy only the namespace-filtered subset
- Output is clean text suitable for pasting in bug reports, chat, etc.

## Loading Strategy

### Development: Always Loaded

In dev, Eruda + the gg plugin load eagerly for instant access:

```svelte
<!-- In your root +layout.svelte -->
<script>
	import { gg } from '@leftium/gg';
	import { initGgEruda } from '@leftium/gg/eruda';
	import { DEV } from 'esm-env';

	if (DEV) {
		initGgEruda();
	}
</script>
```

Or simply:

```svelte
<script>
	import { initGgEruda } from '@leftium/gg/eruda';

	// initGgEruda checks DEV internally, no-ops in production
	initGgEruda();
</script>
```

### Production: Async On-Demand Loading

In production, Eruda is heavy (~100kb gzipped). It should only load when explicitly requested.

**Important**: The gg core function uses the **same trigger** as Eruda loading. When you activate Eruda with `?gg`, the gg core function also enables itself. This ensures consistent behavior - no wasted capture when Eruda isn't loaded, and gg output is always available when Eruda is active.

#### Default Trigger: `?gg` URL Parameter

Navigate to any page with `?gg` appended to the URL:

```
https://my-app.com/dashboard?gg
```

This is the default production trigger. It's short, on-brand, and easy to type on a mobile keyboard.

#### Additional Trigger Options

```typescript
import { initGgEruda } from '@leftium/gg/eruda';

initGgEruda({
	// In dev: always load eagerly
	// In prod: load async when any trigger fires
	prod:
		| ['url-param', 'gesture'] // (default) ?gg OR 5 rapid taps
		| 'url-param'              // ?gg only
		| 'localStorage'           // localStorage 'gg-enabled' === 'true'
		| 'gesture'                // 5 rapid taps only
		| false                    // never load in prod
});
```

- **`['url-param', 'gesture']`** (default) - both triggers active. `?gg` in the URL for easy sharing, plus 5 rapid taps for when you can't modify the URL (e.g., in a webview). Whichever fires first wins.
- **`'url-param'`** - only `?gg` URL parameter. Sets `localStorage['gg-enabled'] = 'true'` to persist across navigations.
- **`'gesture'`** - only 5 rapid taps anywhere on the page. Also persists to localStorage.
- **`'localStorage'`** - checks `localStorage.getItem('gg-enabled') === 'true'`. Already persists across navigations from other triggers.

`initGgEruda` keeps the import in the code (so it's always available) but defers the heavy Eruda load until the trigger fires. The `@leftium/gg/eruda` entry point itself is tiny - just the trigger logic. Eruda is `import()`'d dynamically only when activated.

#### Environment Variable Hard-Disable

For production builds where gg should **never** be available at runtime (even with triggers), set the environment variable:

```bash
# Single variable — works for both browser and SSR (recommended)
GG_ENABLED=false npm run build

# Or explicitly for browser-only builds (VITE_ prefix required without the plugin)
VITE_GG_ENABLED=false npm run build
```

The gg Vite plugin (`ggPlugins()` / `ggCallSitesPlugin`) automatically aliases `GG_ENABLED` to `VITE_GG_ENABLED` at build time, so plain `GG_ENABLED` works for client-side code too. If `VITE_GG_ENABLED` is set explicitly it takes precedence. SSR always reads `process.env.GG_ENABLED` directly.

`GG_ENABLED` can also force-enable gg in production without a runtime trigger:

```bash
GG_ENABLED=true npm run build   # or set in deployment env (e.g. Vercel)
```

When `GG_ENABLED=false`, the gg core function is completely disabled and **cannot** be re-enabled at runtime via `?gg` or any other trigger. This takes absolute precedence over all other settings.

### Gating Strategy: gg Core vs Eruda Widget

The gg core function and Eruda widget share the same runtime triggers but have different override capabilities:

| Aspect                | gg Core Function                                            | Eruda Widget                        |
| --------------------- | ----------------------------------------------------------- | ----------------------------------- |
| **ENV hard-disable**  | `GG_ENABLED=false` → completely disabled, no runtime enable | N/A - respects gg's enabled state   |
| **DEV mode**          | Always enabled (unless ENV-disabled)                        | Always loaded                       |
| **PROD mode default** | Disabled, requires trigger                                  | Not loaded, requires trigger        |
| **PROD trigger**      | `?gg` URL param → enables + persists to localStorage        | `?gg` OR 5 taps → loads Eruda async |
| **localStorage key**  | `gg-enabled`                                                | Same - checks `gg-enabled` state    |
| **Runtime enable**    | Only if not ENV-disabled                                    | Always available (lazy load)        |

This alignment ensures:

- **Consistent activation**: One `?gg` trigger enables both gg core and loads Eruda
- **No wasted work**: gg doesn't capture logs when Eruda isn't loaded
- **Security**: ENV disable prevents any gg execution in sensitive prod builds
- **Flexibility**: Can use gg without Eruda (desktop DevTools), or Eruda without gg (other debug namespaces)

### Bundle Impact

| Scenario              | What's loaded                | Size             |
| --------------------- | ---------------------------- | ---------------- |
| `gg` only (no widget) | Core gg function             | ~5kb gz          |
| Dev with Eruda        | gg + Eruda + gg plugin       | ~105kb gz        |
| Prod (dormant)        | gg + trigger logic           | ~5.5kb gz        |
| Prod (activated)      | gg + async Eruda + gg plugin | ~105kb gz (lazy) |
| Prod (ENV disabled)   | Empty no-op function         | ~0.1kb gz        |

## How Capture Works

### Hook Mechanism

The plugin installs a hook into the `gg()` function pipeline via an internal event emitter. Every `gg()` call:

1. Executes normally (logging to console via `debug`)
2. The hook pushes the output into the plugin's capture buffer

```typescript
// Internal hook added to gg.ts
interface CapturedEntry {
    namespace: string;   // e.g., "gg:routes/+page.svelte@handleClick" (always gg: prefixed)
    message: string;     // Formatted message string
    args: unknown[];     // Raw arguments for expandable view
    timestamp: number;   // Date.now()
}

// gg._onLog is registered by the plugin on init
gg._onLog = (entry: CapturedEntry) => { ... };
```

### Capture Is Independent of `debug` Enable State

> **Overhauled.** The [two-layer filtering spec](./completed/gg-two-layer-filtering.md) replaced this single-layer model with `gg-keep` (buffer gate) and `gg-show` (display filter). `localStorage.debug` is no longer used by gg. Native console output is controlled by the `gg-console` toggle.

The plugin captures **all** `gg()` calls regardless of `localStorage.debug`. This means:

- You see all output in the gg tab even if `localStorage.debug` doesn't match
- The namespace manager controls what appears in the **console** (Eruda's Console tab + browser console)
- The plugin's own filter controls what's visible in the **gg tab**

This separation is valuable: console quiet but gg tab comprehensive, or vice versa.

### Buffer Management

- Default max buffer size: **2000 loggs** (configurable)
- When full, oldest loggs are evicted (ring buffer)
- Clear button empties the buffer
- Buffer is **in-memory only** - cleared on page reload
- The `gg-keep` gate controls what enters the buffer — see [completed/gg-two-layer-filtering.md](./completed/gg-two-layer-filtering.md)

## Proposed API

### Package Export

```json
{
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"default": "./dist/index.js"
		},
		"./eruda": {
			"types": "./dist/eruda/index.d.ts",
			"default": "./dist/eruda/index.js"
		}
	}
}
```

### `initGgEruda(options?)`

```typescript
interface GgErudaOptions {
	/** How to load in production. Default: ['url-param', 'gesture'] */
	prod?:
		| Array<'url-param' | 'localStorage' | 'gesture'>
		| 'url-param'
		| 'localStorage'
		| 'gesture'
		| false;

	/** Max captured log entries. Default: 2000 */
	maxEntries?: number;

	/** Auto-enable localStorage.debug = 'gg:*' if unset. Default: true */
	autoEnable?: boolean;

	/** Additional Eruda options passed to eruda.init(). Default: {} */
	erudaOptions?: Record<string, unknown>;
}

function initGgEruda(options?: GgErudaOptions): void;
```

### Eruda Plugin Object

The plugin follows Eruda's plugin API:

```typescript
eruda.add({
	name: 'gg',
	init($el) {
		// Render namespace filter, log viewer, namespace manager
		// Register gg._onLog hook
	},
	show() {
		/* activate */
	},
	hide() {
		/* deactivate */
	},
	destroy() {
		// Unregister gg._onLog hook
		// Clean up buffer
	}
});
```

---

## Chii Companion Tool: Remote Desktop Debugging

When you need more than Eruda offers (breakpoints, profiling, memory inspector, full network waterfall, live CSS editing), [Chii](https://github.com/liriliri/chii) provides the real Chrome DevTools frontend on your desktop, connected to the mobile page via WebSocket. It's from the same author as Eruda.

Chii is **not part of `@leftium/gg`** - it's a standalone tool that works with any web app. It's listed here because it complements the Eruda plugin well: Eruda for quick on-device gg-specific debugging, Chii for full-power remote debugging.

### How Chii Works

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│  Mobile Device   │ ◄──────────────► │  Desktop Browser  │
│                  │                   │                   │
│  Your app +      │                   │  Chrome DevTools  │
│  Chobitsu        │                   │  frontend (Chii)  │
│  (CDP in JS)     │                   │                   │
└─────────────────┘                   └─────────────────┘
        ▲                                      ▲
        │ <script src="target.js">             │ http://localhost:8080
        │                                      │
        └──────────── Chii Server ─────────────┘
                    (Node.js, port 8080)
```

1. **Chii server** runs on your dev machine (`npx chii start -p 8080`)
2. **Target page** (on mobile) loads a small script that includes [Chobitsu](https://github.com/liriliri/chobitsu) (Chrome DevTools Protocol implemented in JS)
3. **Desktop browser** opens `http://localhost:8080` and gets the actual Chrome DevTools frontend
4. Click "inspect" on the listed target - full DevTools connected to the mobile page

`gg()` output appears correctly in Chii's console since it uses standard `console.debug` with `%c` CSS formatting.

### Eruda vs. Chii

|                            | Eruda + gg plugin (on-device) | Chii (remote)                 |
| -------------------------- | ----------------------------- | ----------------------------- |
| **Console**                | Reimplemented, good enough    | Real Chrome DevTools console  |
| **gg output**              | Yes (`%c` renders correctly)  | Yes (`%c` renders correctly)  |
| **gg namespace filtering** | Yes (gg plugin)               | No                            |
| **Debugger / breakpoints** | No                            | Yes                           |
| **Profiling**              | No                            | Yes                           |
| **Memory inspector**       | No                            | Yes                           |
| **Network**                | Basic (XHR/Fetch list)        | Full (timing, waterfall)      |
| **Elements**               | Basic DOM tree                | Full with live CSS editing    |
| **Requires network**       | No                            | Yes (WebSocket)               |
| **Setup**                  | One import                    | Install Chii + add script tag |

### Setup

```bash
# Install globally
npm install chii -g

# Start the server
chii start -p 8080
```

Add the target script to your page (manually or via a Vite plugin):

```html
<script src="//your-dev-machine-ip:8080/target.js"></script>
```

Then open `http://localhost:8080` on your desktop.

### Vite Plugin Opportunity

No `vite-plugin-chii` currently exists on npm. A Vite plugin that auto-starts the Chii server and injects the target script would streamline the setup. This is a good candidate for a separate package (`vite-plugin-chii` or `@leftium/vite-plugin-chii`) since it's useful to anyone, not just `gg` users.

### Using Eruda and Chii Together

They're not mutually exclusive. Eruda runs as an in-page overlay for quick gg namespace filtering and log copying. Chii connects remotely for breakpoints and profiling. Both can run simultaneously on the same page.

---

## Alternatives Considered

### Standalone Widget (No Eruda)

Building a custom floating panel from scratch.

**Pros:**

- No dependency on Eruda (~100kb)
- Full control over UI/UX
- Lighter weight

**Cons:**

- Must build: floating button, dragging, panel chrome, resizing, JS execution input, theme support
- Ongoing maintenance of UI infrastructure unrelated to `gg`'s purpose
- Reinventing what Eruda/vConsole already do well

**Verdict:** Not worth it for v1. Eruda is well-maintained (20.7k stars, active releases) and solves the hard UI problems. A standalone widget could be added later as `@leftium/gg/widget` if there's demand for a lighter option.

### vConsole Plugin Instead of Eruda

vConsole (Tencent, 17.4k stars) also has a plugin API.

**Pros:**

- Smaller (~40kb gz vs ~100kb)
- Used by WeChat ecosystem

**Cons:**

- Last release June 2023 (less active than Eruda's June 2025)
- Plugin API is event-based (more boilerplate)
- Written in Svelte internally (interesting overlap) but older patterns

**Verdict:** Eruda is more actively maintained and has a simpler plugin API. Could support vConsole later if requested.

### Dedicated Route

A `/gg-debug` route that shows the log viewer UI.

**Pros:**

- Full-page layout, more room
- No overlay/z-index issues

**Cons:**

- Navigating away from the page you're debugging loses context
- Harder to use while interacting with the app
- Requires SvelteKit

**Verdict:** The Eruda overlay is better for live debugging. A route could complement it later for reviewing longer sessions.

### Persisting to IndexedDB or localStorage

**Verdict:** Not needed for v1. In-memory buffer is sufficient. The primary job is live debugging. If persistence is needed later, IndexedDB would be the right choice.

### Superseding `gg.persist`

The `gg.persist` spec proposed a separate `ggg()` function that captures output to a global array. The Eruda plugin approach is superior because:

1. **Zero API surface** - no `ggg`, no `.log()`, no `.messages()`, no `.clear()`
2. **No code changes** - existing `gg()` calls are automatically captured
3. **Better UX** - full Eruda panel with JS execution, not just `copy(ggg.log())`
4. **Solves the actual problem** - "I can't access my debug output on mobile"

The only capability lost is server-side programmatic log access. Server environments have stdout, log files, and full terminal access. If needed, a lightweight server-side capture API can be added independently.

## Implementation Status

| Feature                                                           | Status          | Key Files                                                                        |
| ----------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------- |
| Eruda plugin with GG tab                                          | **Implemented** | `src/lib/eruda/plugin.ts` (2889 lines)                                           |
| Ring buffer (2000 loggs)                                          | **Implemented** | `src/lib/eruda/buffer.ts`                                                        |
| Namespace-aware filtering (wildcard patterns)                     | **Implemented** | `plugin.ts` (filter UI, `namespaceMatchesPattern`)                               |
| Segmented namespace clicks (left-click solo, right-click exclude) | **Implemented** | `plugin.ts`                                                                      |
| Hide toast with undo and segment-level control                    | **Implemented** | `plugin.ts` (`showHideToast`, `undoHide`)                                        |
| Hide button `[x]` per namespace (on hover)                        | **Implemented** | `plugin.ts` (`.gg-ns-hide`)                                                      |
| Copy filtered loggs                                               | **Implemented** | `plugin.ts` (`formatEntryForClipboard`)                                          |
| Virtual scrolling                                                 | **Implemented** | `plugin.ts` (uses `@tanstack/virtual-core`)                                      |
| `GgConsole.svelte` wrapper component                              | **Implemented** | `src/lib/GgConsole.svelte`                                                       |
| Production triggers (`?gg`, gesture, localStorage)                | **Implemented** | `src/lib/eruda/loader.ts`, `src/lib/eruda/index.ts`                              |
| Internal `debug` package replacement                              | **Implemented** | `src/lib/debug/common.ts`, `browser.ts`, `node.ts`                               |
| `localStorage.debug` manager (Sync/Clear buttons)                 | **Superseded**  | Replaced by `gg-console` toggle + `gg-keep`/`gg-show` panels                     |
| Auto-discovered namespace checkbox list                           | **Implemented** | Keep/Show panels with checkbox lists (`plugin.ts`)                               |
| Namespace presets (All/Routes/Lib/Off)                            | **Deferred**    | Keep/Show checkboxes cover the use case; presets not built                       |
| `autoEnable` option for `localStorage.debug`                      | **Superseded**  | Replaced by two-layer filtering                                                  |
| Two-layer filtering (`gg-keep`/`gg-show`)                         | **Implemented** | See [completed/gg-two-layer-filtering.md](./completed/gg-two-layer-filtering.md) |

## Open Questions

1. ~~**Should `initGgEruda()` auto-enable `localStorage.debug`?**~~ **Moot.** The [two-layer filtering spec](./completed/gg-two-layer-filtering.md) replaced `localStorage.debug` with `gg-keep`/`gg-show`. Default is `*` (keep/show everything), so gg "just works" without manual setup.

2. ~~**Eruda as peer dependency or bundled?**~~ **Resolved.** Dynamic `import('eruda')` in `loader.ts` -- exactly as recommended. Users install Eruda as a dev dependency.

3. ~~**Log format in the gg tab**~~ **Resolved.** Mirrors console format: colored namespace, time diff, message. Plus expandable objects, stack traces, expression toggle, virtual scrolling. Exceeds spec expectations.

4. ~~**Should the gg tab replace or supplement Eruda's Console tab?**~~ **Resolved.** Supplements as an additional "GG" tab. Console tab remains available.

5. ~~**Capture before plugin init**~~ **Resolved.** Capture begins when `initGgEruda()` runs via the `_onLog` hook. Pre-init calls are not buffered.

## References

- [gg-two-layer-filtering spec](./completed/gg-two-layer-filtering.md) -- filtering model overhaul (implemented)
- [Eruda](https://github.com/liriliri/eruda) - mobile debug console (20.7k stars, ~100kb gz)
- [Eruda Plugin Docs](https://eruda.liriliri.io/docs/plugin.html) - plugin API reference
- [Chii](https://github.com/liriliri/chii) - remote debugging with Chrome DevTools frontend (2.2k stars, same author as Eruda)
- [Chii Docs](https://chii.liriliri.io/docs/) - usage and Chobitsu API
- [Chobitsu](https://github.com/liriliri/chobitsu) - Chrome DevTools Protocol JS implementation (used by Chii)
- [vConsole](https://github.com/Tencent/vConsole) - Tencent's mobile debug console (17.4k stars, ~40kb gz)
- [TanStack Query Devtools](https://tanstack.com/query/latest/docs/framework/react/devtools) - inspiration for floating button pattern
- [debug package](https://www.npmjs.com/package/debug) - gg's internal debug implementation replaces this (see `src/lib/debug/`)
