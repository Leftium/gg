# gg: never use console.log() to debug again!

`gg()` is a lo**gg**er/debu**gg**er with several advantages:

- Annotated with automatic _namespace_ based on source file and calling function.
  - Each namespace gets a unique color for easier visual parsing.
  - Simple syntax with wildcards to filter/hide debug output at runtime.
  - Millisecond diff (timestamps) for each namespace.
- Chainable API: `.ns()`, `.warn()`, `.error()`, `.info()`, `.trace()`, `.table()`.
- Can be inserted into the middle of expressions (use `.v` to get the passthrough value).
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

	// Log with modifiers
	gg('Connection timeout').warn();
	gg('User authenticated', user).info();

	// Passthrough with .v (returns the first argument)
	const result = gg(someFunction()).v;

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

### 3. Add the debug console (optional, recommended)

An in-browser debug console (powered by Eruda) with a dedicated GG tab for filtering and inspecting logs -- especially useful on mobile.

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

## Chaining API

`gg()` returns a `GgChain<T>` with composable modifiers. Chain any combination, in any order. The log auto-flushes on the next microtask, or use `.v` to flush immediately and get the passthrough value.

```javascript
import { gg } from '@leftium/gg';

// Basic logging (auto-flushes on microtask)
gg('hello');
gg('multiple', 'args', { data: 42 });

// Passthrough with .v (flushes immediately, returns first arg)
const result = gg(computeValue()).v;
const user = gg(await fetchUser()).ns('api').v;

// Log levels
gg('System ready').info(); // blue indicator
gg('Deprecated API call').warn(); // yellow indicator
gg('Connection failed').error(); // red indicator + stack trace

// Custom namespace
gg('Processing request').ns('api:handler');

// Stack trace
gg('Debug checkpoint').trace();

// Table formatting (also emits native console.table)
gg(arrayOfObjects).table();
gg(data).table(['name', 'age']); // filter columns

// Combine modifiers freely
gg('Slow query', { ms: 3200 }).ns('db').warn();
const rows = gg(queryResult).ns('db:query').table().v;
```

### `.v` -- Passthrough

Use `.v` at the end of any chain to flush the log immediately and return the first argument. This lets you insert `gg()` into the middle of expressions:

```javascript
// Without .v: logs on microtask, returns GgChain (not the value!)
gg(someValue);

// With .v: logs immediately, returns someValue
const x = gg(someValue).v;
const y = gg(compute()).ns('math').warn().v;

// Insert into expressions
processData(gg(inputData).v);
return gg(result).ns('output').v;
```

### `.ns(label)` -- Custom Namespace

Override the auto-generated namespace (file@function) with a custom label. Useful for grouping related logs across files:

```javascript
gg('Request received').ns('api:incoming');
gg('Response sent').ns('api:outgoing');
gg('Cache hit').ns('api:cache');
```

Namespace labels support **template variables** that resolve from plugin-provided metadata:

| Variable | Description                   | Example                           |
| -------- | ----------------------------- | --------------------------------- |
| `$NS`    | Full auto-generated callpoint | `routes/+page.svelte@handleClick` |
| `$FN`    | Enclosing function name       | `handleClick`                     |
| `$FILE`  | Source file path              | `routes/+page.svelte`             |
| `$LINE`  | Line number                   | `42`                              |
| `$COL`   | Column number                 | `3`                               |

```javascript
gg('debug info').ns('ERROR:$NS'); // → ERROR:routes/+page.svelte@handleClick
gg('validation').ns('$FILE:validate'); // → routes/+page.svelte:validate
gg('step 1').ns('TRACE:$FN'); // → TRACE:handleClick
gg('context').ns('$NS:debug'); // → routes/+page.svelte@handleClick:debug
```

Without the Vite plugin, `$NS` falls back to a runtime word-tuple (e.g. `calm-fox`). `$FN`, `$FILE`, `$LINE`, and `$COL` require the plugin.

### `.info()` / `.warn()` / `.error()` -- Log Levels

```javascript
gg('Server started on port 3000').info(); // blue badge
gg('Rate limit approaching').warn(); // yellow badge
gg('Unhandled exception').error(); // red badge + captures stack

// .error() with an Error object uses its .stack
try {
	riskyOperation();
} catch (err) {
	gg(err).error();
}
```

### `.trace()` -- Stack Trace

Captures a full stack trace (cleaned of internal gg frames) alongside the log entry:

```javascript
gg('How did we get here?').trace();
```

### `.table(columns?)` -- Table Formatting

Formats the first argument as a table. Also emits a native `console.table()` call. Optionally filter columns:

```javascript
gg([
	{ name: 'Alice', age: 30, role: 'admin' },
	{ name: 'Bob', age: 25, role: 'user' }
]).table();

// Filter columns
gg(users).table(['name', 'role']);

// Works with objects-of-objects and arrays of primitives too
gg({ us: { pop: '331M' }, uk: { pop: '67M' } }).table();
gg(['apple', 'banana', 'cherry']).table();
```

## Timers

Measure elapsed time with `gg.time()`, `gg.timeLog()`, and `gg.timeEnd()`:

```javascript
import { gg } from '@leftium/gg';

gg.time('fetch');

// ... some work ...
gg.timeLog('fetch', 'headers received'); // logs elapsed without stopping

// ... more work ...
gg.timeEnd('fetch'); // logs elapsed and stops timer
```

### Timer Namespaces

`gg.time()` returns a `GgTimerChain` that supports `.ns()` for grouping. The namespace is inherited by subsequent `timeLog` and `timeEnd` calls for the same label:

```javascript
gg.time('fetch').ns('api-pipeline');

gg.timeLog('fetch', 'step 1 done'); // logged under 'api-pipeline'
gg.timeEnd('fetch'); // logged under 'api-pipeline'

// Template variables work too
gg.time('db-query').ns('$FN:timers');
```

## `gg.here()` -- Open in Editor

Returns call-site metadata for rendering "open in editor" links. Replaces the old no-arg `gg()` introspection.

```svelte
<script>
	import { gg } from '@leftium/gg';
</script>

<!-- Pass to a link component -->
<OpenInEditorLink gg={gg.here()} />
```

Returns `{ fileName, functionName, url }` where `url` points to the dev server's open-in-editor endpoint.

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

## Text Styling (ANSI)

Add visual emphasis to logs with `bold()`, `italic()`, `underline()`, and `dim()`. These can be used standalone or chained with colors:

```javascript
import { gg, fg, bg, bold, italic, underline, dim } from '@leftium/gg';

// Standalone text styles
gg(bold()`Bold text`);
gg(italic()`Italic text`);
gg(underline()`Underlined text`);
gg(dim()`Dimmed/faint text`);

// Combined with colors
gg(fg('red').bold()`Bold red error`);
gg(fg('green').bold()`Bold green success`);
gg(bg('yellow').italic()`Italic on yellow background`);
gg(fg('blue').underline()`Blue underlined text`);

// Multiple styles chained
gg(bold().italic()`Bold and italic`);
gg(fg('red').bold().underline()`Bold underlined red`);

// Reusable style presets
const finalStyle = fg('green').bold();
const interimStyle = fg('gray');

gg(finalStyle`final` + ' seg=0 "my name is John Kim Murphy" 96%');
gg(interimStyle`interim` + ' seg=0 "my name is John Kim Murphy" 90%');

// Mixed inline styling
gg(bold()`Important:` + ' normal text ' + italic()`with emphasis`);
```

**Available styles:**

- `bold()` - Bold/strong text (font-weight: bold)
- `italic()` - Italic/emphasized text (font-style: italic)
- `underline()` - Underlined text (text-decoration: underline)
- `dim()` - Dimmed/faint text (opacity: 0.6)

Text styles work in the same environments as colors (browser console, GgConsole, terminal).

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

## API Reference

### `gg(value, ...args)` -- Returns `GgChain<T>`

| Method / Property | Description                                   |
| ----------------- | --------------------------------------------- |
| `.v`              | Flush log immediately, return first argument  |
| `.ns(label)`      | Set custom namespace (supports template vars) |
| `.info()`         | Set log level to info                         |
| `.warn()`         | Set log level to warn                         |
| `.error()`        | Set log level to error (captures stack)       |
| `.trace()`        | Attach full stack trace                       |
| `.table(cols?)`   | Format as table, optional column filter       |

### `gg.time(label?)` -- Returns `GgTimerChain`

| Method       | Description                               |
| ------------ | ----------------------------------------- |
| `.ns(label)` | Set namespace for timer group (inherited) |

### `gg.timeLog(label?, ...args)` -- Log elapsed without stopping

### `gg.timeEnd(label?)` -- Log elapsed and stop timer

### `gg.here()` -- Returns `{ fileName, functionName, url }`

### Control

| Method              | Description                               |
| ------------------- | ----------------------------------------- |
| `gg.enable(ns)`     | Enable debug output for namespace pattern |
| `gg.disable()`      | Disable all debug output                  |
| `gg.clearPersist()` | Clear `gg-enabled` from localStorage      |

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

### Microtask Auto-Flush

When you call `gg(value)`, the log is **deferred to the next microtask**. This means chain modifiers (`.ns()`, `.warn()`, etc.) can be added synchronously after the call. If you need the value immediately (passthrough), use `.v` which forces an immediate flush.

```javascript
// These two are equivalent:
gg('hello').warn(); // .warn() runs sync, log flushes on microtask
gg('hello').warn().v; // .v forces immediate flush + returns 'hello'

// Auto-flush means order doesn't matter for modifiers:
gg('x').ns('foo').warn(); // same as:
gg('x').warn().ns('foo'); // (both set ns and level before flush)
```

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
