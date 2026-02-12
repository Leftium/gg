# gg: never use console.log() to debug again!

`gg()` is a lo**gg**er/debu**gg**er with several advantages:

- Annotated with automatic _namespace_ based on source file and calling function.
  - Each namespace gets a unique color for easier visual parsing.
  - Simple syntax with wildcards to filter/hide debug output at runtime.
  - Millisecond diff (timestamps) for each namespace.
- Can be inserted into the middle of expressions (returns the value of the first argument).
- Can output a link that opens the source file in your editor (like VS Code).
- Simple to disable (turn all loggs into NOP's for production).
- Diagnostics/hints in dev console & terminal to help install and configure correctly.
- Faster to type.

## Installation

```
npm add @leftium/gg
```

## SvelteKit Quick Start

### 1. Use `gg()` anywhere

```svelte
<script>
	import { gg } from '@leftium/gg';

	gg('Hello world');

	// Log expressions (returns first argument)
	const result = gg(someFunction());

	// Multiple arguments
	gg('User:', user, 'Status:', status);
</script>
```

That's it! Output appears in the browser dev console and terminal. The following optional steps are highly recommended to unlock the full experience:

### 2. Add Vite plugins (optional, recommended)

Without plugins, namespaces are random word-tuples. With plugins, you get real file/function callpoints, open-in-editor links, and icecream-style source expressions.

```ts
// vite.config.ts
import ggPlugins from '@leftium/gg/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), ...ggPlugins()]
});
```

`ggPlugins()` includes:

- **Call-sites plugin** -- rewrites `gg()` calls with source file/line/col metadata
- **Open-in-editor plugin** -- adds dev server middleware for click-to-open
- **Automatic `es2022` target** -- required for top-level await

### 3. Add the debug console (optional, recommended)

An in-browser debug console (powered by Eruda) with a dedicated GG tab for filtering and inspecting logs — especially useful on mobile.

```svelte
<!-- src/routes/+layout.svelte -->
<script>
	import { GgConsole } from '@leftium/gg';
</script>

<GgConsole />
{@render children()}
```

In development, the debug console appears automatically.
In production, add `?gg` to the URL or use a 5-tap gesture to activate.

## GgConsole Options

```svelte
<GgConsole prod={['url-param', 'gesture']} maxEntries={5000} />
```

| Prop           | Type                       | Default                    | Description                    |
| -------------- | -------------------------- | -------------------------- | ------------------------------ |
| `prod`         | `Array \| string \| false` | `['url-param', 'gesture']` | Production activation triggers |
| `maxEntries`   | `number`                   | `2000`                     | Max log entries in ring buffer |
| `erudaOptions` | `object`                   | `{}`                       | Pass-through options to Eruda  |

**Production triggers:**

- `'url-param'` -- activate with `?gg` in the URL (persists to localStorage)
- `'gesture'` -- activate with 5 rapid taps anywhere on the page
- `'localStorage'` -- activate if `localStorage['gg-enabled']` is `'true'`
- `false` -- disable debug console in production entirely

## Vite Plugin Options

```ts
import ggPlugins from '@leftium/gg/vite';

ggPlugins({
	callSites: { srcRootPattern: '.*?(/src/)' },
	openInEditor: false // disable open-in-editor middleware
});
```

Individual plugins are also available for advanced setups:

```ts
import { ggCallSitesPlugin, openInEditorPlugin } from '@leftium/gg/vite';
```

## Color Support (ANSI)

Color your logs for better visual distinction using `fg()` (foreground/text) and `bg()` (background):

```javascript
import { gg, fg, bg } from '@leftium/gg';

// Simple foreground/background colors
gg(fg('red')`Error occurred`);
gg(bg('yellow')`Warning message`);

// Method chaining (order doesn't matter!)
gg(fg('white').bg('red')`Critical error!`);
gg(bg('green').fg('white')`Success message`);

// Define reusable color schemes
const input = fg('blue').bg('yellow');
const transcript = bg('green').fg('white');
const error = fg('white').bg('red');

gg(input`User input message`);
gg(transcript`AI transcript response`);
gg(error`Something went wrong`);

// Mix colored and normal text
gg(fg('red')`Error: ` + bg('yellow')`warning` + ' normal text');

// Custom hex colors with chaining
gg(fg('#ff6347').bg('#98fb98')`Custom colors`);

// RGB colors
gg(fg('rgb(255,99,71)')`Tomato text`);
```

**Supported color formats:**

- Named colors: `'red'`, `'green'`, `'blue'`, `'cyan'`, `'magenta'`, `'yellow'`, `'white'`, `'black'`, `'gray'`, `'orange'`, `'purple'`, `'pink'`
- Hex codes: `'#ff0000'`, `'#f00'`
- RGB: `'rgb(255,0,0)'`, `'rgba(255,0,0,0.5)'`

**Where colors work:**

- Native browser console (Chrome DevTools, Firefox, etc.)
- GgConsole debug panel (mobile debugging)
- Node.js terminal
- All environments that support ANSI escape codes

## Other Frameworks

`gg()` works in any JavaScript project. The Vite plugins work with any Vite-based framework (React, Vue, Solid, etc.).

### Vanilla / Non-Svelte Setup

```ts
// vite.config.ts
import ggPlugins from '@leftium/gg/vite';

export default defineConfig({
	plugins: [...ggPlugins()]
});
```

```js
// app.js
import { gg } from '@leftium/gg';
import { initGgEruda } from '@leftium/gg/eruda';

initGgEruda();
gg('works in any framework');
```

## Technical Details

### Internal Debug Implementation

This library includes an **internal TypeScript implementation** inspired by the [`debug`](https://www.npmjs.com/package/debug) package. The output format displays time diffs **before** the namespace for better readability:

**Output format:**

```
 +123ms gg:routes/+page.svelte
```

Features implemented internally (~290 lines of TypeScript):

- Color hashing algorithm for consistent namespace colors
- Millisecond diff formatting (e.g., `+123ms`, `+2s`, `+5m`)
- Namespace wildcard matching (`gg:*`, `gg:routes/*`, `-gg:test`)
- localStorage.debug / process.env.DEBUG persistence
- Browser and Node.js environments

This approach eliminates the need for vendoring, patching, and bundling third-party code, resulting in better type safety and simpler maintenance.

## Inspirations

### debug

> A tiny JavaScript debugging utility modelled after Node.js core's debugging technique. Works in Node.js and web browsers.

- https://www.npmjs.com/package/debug

### q (python)

> Quick and dirty debugging output for tired programmers.

- https://github.com/zestyping/q
- [Hacker News discussion](https://hw.leftium.com/#/item/9981430)
- [PyCon lightning talk](https://www.youtube.com/watch?v=OL3De8BAhME#t=25m15s)

### IceCream (python)

> Never use print() to debug again

- https://github.com/gruns/icecream
- [Hacker News discussion](https://hw.leftium.com/#/item/26631467)
