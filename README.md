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

## Usage

### Basic Logging

```javascript
import { gg } from '@leftium/gg';

// Simple logging
gg('Hello world');

// Log expressions (returns first argument)
const result = gg(someFunction());

// Multiple arguments
gg('User:', user, 'Status:', status);
```

### Color Support (ANSI)

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

- ✅ Native browser console (Chrome DevTools, Firefox, etc.)
- ✅ Eruda GG panel (mobile debugging)
- ✅ Node.js terminal
- ✅ All environments that support ANSI escape codes

## Technical Details

### Bundled Dependencies

This library includes a **patched version** of the [`debug`](https://www.npmjs.com/package/debug) package. The patch reformats the output to display time diffs **before** the namespace for better readability:

**Standard debug output:**

```
  gg:routes/+page.svelte +123ms
```

**Patched output (this library):**

```
 +123ms gg:routes/+page.svelte
```

The patched `debug` library is bundled directly into the distribution, so consumers automatically get the correct behavior without needing to install or patch `debug` themselves.

### Updating the Bundled debug Library

When a new version of `debug` is released:

1. Update debug: `pnpm add debug@x.x.x`
2. Update patch: `pnpm patch debug@x.x.x` (apply changes, then `pnpm patch-commit`)
3. Run the update script: `./scripts/update-debug.sh`
4. Verify patches are present: `git diff src/lib/debug/src/`
5. Test dev mode: `pnpm dev`
6. Test production build: `pnpm prepack`
7. Commit changes: `git commit -am "Update bundled debug to x.x.x"`

The patch is maintained in `patches/debug@4.4.3.patch` for reference.

**Note:** `debug` is kept in dependencies (not devDependencies) to support both dev and production modes.

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
