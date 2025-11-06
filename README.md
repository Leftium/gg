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

_Coming soon..._

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

1. Update debug in devDependencies: `pnpm add -D debug@x.x.x`
2. Run the update script: `./scripts/update-debug.sh`
3. Verify patches still apply: `git diff src/lib/debug/`
4. Test: `pnpm dev && pnpm prepack`
5. Commit: `git commit -am "Update bundled debug to x.x.x"`

The patch is maintained in `patches/debug@4.4.3.patch` for reference.

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
