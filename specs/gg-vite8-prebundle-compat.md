# Vite 8 Pre-Bundle Compatibility

**Date**: 2026-03-31
**Status**: Draft
**Author**: AI-assisted

## Overview

Vite 8's esbuild pre-bundler strips `/* @vite-ignore */` comments from pre-bundled output, causing `vite:import-analysis` to reject the dynamic import of `virtual:gg-file-sink-sender` in `gg.js`. A secondary issue: the runtime entry (`index.ts`) re-exports Vite plugins that import `svelte/compiler`, pulling compiler internals into the browser module graph when pre-bundling is bypassed. Both issues are fixable in gg with minimal changes.

## Motivation

### Current State

Consumers of `@leftium/gg` on Vite 8 get a hard error on `pnpm dev`:

```
[plugin:vite:import-analysis] Failed to resolve import
"/@id/virtual:gg-file-sink-sender" from
"node_modules/.vite/deps/gg-T7yX7eZD.js"
```

The workaround requires adding a custom Vite plugin in the consumer's `vite.config.ts`:

```ts
function ggVirtualModuleFix(): Plugin {
	return {
		name: 'gg-virtual-module-fix',
		enforce: 'pre',
		resolveId(id) {
			if (id === '/@id/virtual:gg-file-sink-sender') {
				return '\0virtual:gg-file-sink-sender';
			}
		}
	};
}
```

This should not be necessary. Every gg consumer on Vite 8 will hit this.

### Root Cause: Virtual Module Import

`gg.ts` dynamically imports the virtual module for the file-sink sender:

```ts
const senderUrl = '/@id/' + 'virtual:gg-file-sink-sender';
import(/* @vite-ignore */ senderUrl).catch(() => {});
```

The `/* @vite-ignore */` comment tells Vite's `vite:import-analysis` plugin to skip static resolution of this import. This worked in Vite 7 because the comment survived into the pre-bundled output.

In Vite 8, esbuild strips all comments during pre-bundling. The pre-bundled `gg.js` chunk contains:

```js
import('/@id/virtual:gg-file-sink-sender').catch(() => {});
```

Without `@vite-ignore`, `vite:import-analysis` tries to resolve `/@id/virtual:gg-file-sink-sender` as a normal module. The `ggFileSinkPlugin`'s `resolveId` only handles the bare `virtual:gg-file-sink-sender` (without the `/@id/` prefix), so resolution fails.

### Secondary Issue: Runtime Entry Exports Vite Plugins

If a consumer works around the first issue by adding `@leftium/gg` to `optimizeDeps.exclude` (skipping pre-bundling), a cascade of new errors appears:

```
SyntaxError: The requested module '.../axobject-query/lib/index.js'
does not provide an export named 'AXObjects'
```

The chain:

```
Browser requests @leftium/gg (excluded from pre-bundling, served raw)
  → index.js imports gg-call-sites-plugin.js
    → gg-call-sites-plugin.ts imports svelte/compiler
      → svelte/compiler/.../a11y/constants.js imports axobject-query
        → axobject-query is CJS-only → named ESM import fails
```

`index.ts` re-exports `ggCallSitesPlugin` and `openInEditorPlugin` — both server-only Vite plugins that should never reach the browser. They're already properly exported from `@leftium/gg/vite`. The runtime entry doesn't need them.

Even when pre-bundling is active (normal case), esbuild includes the plugin code in the pre-bundled chunk unnecessarily, increasing bundle size.

## Design Decisions

| Decision                                            | Choice                                               | Rationale                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fix virtual module resolution                       | Add `/@id/`-prefixed resolveId in `ggFileSinkPlugin` | One-line fix in the plugin. Consumers need zero config. Forward-compatible — works on Vite 7 and 8.                                                                                                                |
| Alternative: make import truly opaque               | No                                                   | Fragile — future bundler changes could defeat any obfuscation. Explicit resolution is robust.                                                                                                                      |
| Alternative: add to consumer's optimizeDeps.exclude | No                                                   | Triggers the secondary `svelte/compiler` → `axobject-query` cascade. Pushes complexity to consumers.                                                                                                               |
| Remove Vite plugin re-exports from index.ts         | Yes                                                  | `ggCallSitesPlugin` and `openInEditorPlugin` are already available via `@leftium/gg/vite`. No consumer should import Vite plugins from the runtime entry. Removes `svelte/compiler` from the browser module graph. |

## Architecture

### Before (Broken)

```
gg.ts (pre-bundled by esbuild, comments stripped)
  │
  │  import("/@id/virtual:gg-file-sink-sender")     ← no @vite-ignore
  │
  ▼
vite:import-analysis
  │
  │  resolveId("/@id/virtual:gg-file-sink-sender")   ← no plugin handles this
  │
  ▼
ERROR: Failed to resolve import
```

### After (Fixed)

```
gg.ts (pre-bundled by esbuild, comments stripped)
  │
  │  import("/@id/virtual:gg-file-sink-sender")
  │
  ▼
vite:import-analysis
  │
  │  resolveId("/@id/virtual:gg-file-sink-sender")
  │
  ▼
ggFileSinkPlugin.resolveId
  │  matches "/@id/virtual:gg-file-sink-sender"
  │  OR       "virtual:gg-file-sink-sender"
  │
  │  returns "\0virtual:gg-file-sink-sender"
  │
  ▼
ggFileSinkPlugin.load
  │  returns virtual module source code
  │
  ▼
OK
```

## Implementation Plan

### Phase 1: Fix Virtual Module Resolution

- [ ] **1.1** In `gg-file-sink-plugin.ts`, update `resolveId` to handle the `/@id/`-prefixed form:
  ```ts
  resolveId(id) {
      if (id === VIRTUAL_MODULE_ID || id === '/@id/' + VIRTUAL_MODULE_ID) {
          return RESOLVED_VIRTUAL_MODULE_ID;
      }
  },
  ```
- [ ] **1.2** Add a comment explaining why both forms are needed (Vite 8 esbuild strips `@vite-ignore`).

### Phase 2: Remove Plugin Re-Exports from Runtime Entry

- [ ] **2.1** In `src/lib/index.ts`, remove the imports and re-exports of `openInEditorPlugin` and `ggCallSitesPlugin`:

  ```diff
  - import openInEditorPlugin from './open-in-editor.js';
  - import ggCallSitesPlugin from './gg-call-sites-plugin.js';

  - export { ..., openInEditorPlugin, ggCallSitesPlugin };
  + export { ... };
  ```

- [ ] **2.2** Verify no internal code imports these plugins from the main entry (they should all use `@leftium/gg/vite` or `./vite.js`).
- [ ] **2.3** Check that `gg-call-sites-plugin.ts` import of `svelte/compiler` no longer appears in the pre-bundled browser chunk (inspect `.vite/deps/` output).

### Phase 3: Build, Pack, Test

- [ ] **3.1** Build and pack the updated gg package.
- [ ] **3.2** Install in `/Volumes/p/weather-sense` (Vite 8 consumer that triggered the bug).
- [ ] **3.3** Remove the `ggVirtualModuleFix` workaround from `weather-sense/vite.config.ts`.
- [ ] **3.4** Remove any `optimizeDeps` overrides from `weather-sense/vite.config.ts`.
- [ ] **3.5** `rm -rf node_modules/.vite && pnpm dev` — expect clean startup, no errors.
- [ ] **3.6** Verify file sink works: `curl /__gg/logs` returns entries after page load.

## Edge Cases

1. **Vite 7 consumers**: The `/@id/`-prefixed `resolveId` will never fire (esbuild preserves comments, `@vite-ignore` works). The bare `virtual:gg-file-sink-sender` path continues to work. No regression.

2. **ggFileSinkPlugin not active**: The `.catch(() => {})` on the dynamic import silently handles the case where no plugin resolves the virtual module (e.g., consumer uses `ggCallSitesPlugin` alone without `ggFileSinkPlugin`). No change needed.

3. **Production builds**: The `BROWSER && DEV` guard prevents the dynamic import from executing. Rollup's static analysis is defeated by string concatenation (`'/@id/' + 'virtual:...'`). No change needed.

4. **Consumers importing plugins from main entry**: Phase 2 is a breaking change for anyone doing `import { ggCallSitesPlugin } from '@leftium/gg'`. This is unlikely — the documented API is `import ggPlugins from '@leftium/gg/vite'` — but should be noted in the changelog.

## Open Questions

1. **~~Should `resolveId` also handle bare `/@id/` prefix for other virtual modules?~~** No. The file-sink sender is the only virtual module gg defines. Keep it specific.

2. **Should Phase 2 be a semver minor or patch?** Technically removing an export is a breaking change (semver major). In practice, no consumer should import Vite plugins from the runtime entry — it was never documented. A minor bump with a changelog note is reasonable.

## Success Criteria

- [ ] `pnpm dev` starts without errors in a Vite 8 consumer with no `optimizeDeps` overrides
- [ ] `pnpm dev` starts without errors in a Vite 7 consumer (regression check)
- [ ] `svelte/compiler` and `axobject-query` do not appear in `.vite/deps/` pre-bundled output
- [ ] File sink captures both SSR and browser entries in the consumer project
- [ ] `vite build` succeeds (Rollup doesn't try to resolve dev-only virtual module)

## References

- `src/lib/gg-file-sink-plugin.ts:198-212` — Virtual module constants and `resolveId` hook
- `src/lib/gg.ts:1530-1551` — Dynamic import of virtual module with `@vite-ignore`
- `src/lib/index.ts` — Runtime entry re-exporting Vite plugins
- `src/lib/vite.ts` — Proper plugin export path (`@leftium/gg/vite`)
- `/Volumes/p/weather-sense/vite.config.ts` — Consumer workaround to be removed after fix
