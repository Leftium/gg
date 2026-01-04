# gg.persist: Clipboard-Friendly Debug Capture

## Overview

Add `gg.persist` - a variant of `gg` that also captures output to a global array for easy clipboard access. This is useful for debugging complex issues where console output is hard to copy (many lines, collapsed objects, etc.).

## Motivation

When debugging, you often want to:

1. See debug output in the console (with colors, timestamps, etc.)
2. Copy that output to share or paste elsewhere

Currently, copying multi-line debug output from the browser console is tedious. `gg.persist` solves this by capturing output to an array that can be easily copied.

## Browser DevTools `copy()` Function

The browser DevTools console has a built-in `copy()` function:

```javascript
copy('hello'); // Copies "hello" to clipboard
copy({ foo: 'bar' }); // Copies JSON stringified object
copy(someVariable); // Copies the value of the variable
```

This is available in Chrome, Firefox, Safari, and Edge DevTools. It's a "Command Line API" function injected by DevTools (not on `window`). By storing captured output in a global variable, users can easily copy it with `copy(ggg.log())`.

## Proposed API

### Basic Usage

```typescript
import { gg } from '@leftium/gg';

// Convention: alias gg.persist to ggg
const ggg = gg.persist;

// ggg works exactly like gg, but also captures to a buffer
ggg('Processing item:', item);
ggg('Result:', result);

// In DevTools console:
copy(ggg.log()); // Copy all captured output to clipboard
ggg.log(); // Returns joined string of all messages
ggg.messages(); // Returns array of individual messages
ggg.clear(); // Clear the buffer
```

### Easy Swap Between gg and gg.persist

```typescript
// During development - capture logs
import { gg } from '@leftium/gg';
const ggg = gg.persist;
ggg('debug message');

// Later - just change one line to disable capture
const ggg = gg;
ggg('debug message'); // Same usage, no capture
```

### Quick One-Off Capture

Use `gg.persist()` directly without aliasing for quick debugging:

```typescript
import { gg } from '@leftium/gg';

// Sprinkle in a few captured logs without setup
gg.persist('checkpoint 1', data);
gg.persist('checkpoint 2', result);

// In DevTools console:
copy(gg.persist.log());
```

### Single Array with Namespace Filtering

All logs are stored in a single array with their namespace. Use debug's wildcard syntax to filter:

```typescript
const ggg = gg.persist;

// Logs from different files get automatic namespaces
// In routes/+page.svelte:
ggg('page message'); // ns: "gg:routes/+page.svelte"

// In lib/util.ts:
ggg('util message'); // ns: "gg:lib/util.ts"

// In routes/+page.svelte with extend:
const wmo = ggg.extend('wmo');
wmo('wmo message'); // ns: "gg:routes/+page.svelte:wmo"

// Filter using debug's wildcard syntax
copy(ggg.log()); // All logs
copy(ggg.log('*')); // All logs (same)
copy(ggg.log('*:wmo')); // Only :wmo sub-namespaces
copy(ggg.log('gg:lib/*')); // Only lib/ files
copy(ggg.log('gg:routes/*')); // Only routes/ files
copy(ggg.log('*+page*')); // Files containing "+page"
```

### Extended Namespaces

Using `extend()` creates sub-namespaces that also capture:

```typescript
const ggg = gg.persist;

const wmo = ggg.extend('wmo');
const temp = ggg.extend('temp');

wmo('Calculating codes'); // ns: "gg:<file>:wmo"
wmo('Selected:', code);

temp('Temperature:', value); // ns: "gg:<file>:temp"

// Filter by extended namespace
copy(ggg.log('*:wmo')); // Only wmo logs
copy(ggg.log('*:temp')); // Only temp logs
copy(wmo.log()); // Also works - just this logger's messages
```

## Implementation Notes

### Storage

- Single array stores all captured messages
- Each entry: `{ namespace: string, message: string, timestamp: number }`
- Array accessible via `globalThis.ggg` for console access (works in browser and server)
- `gg.persist` is pre-instantiated (not a factory function)

### Behavior

- `ggg(...)` calls `gg(...)` internally, then appends to capture array
- `.log(filter?)` filters array by namespace, joins with newlines
- `.messages(filter?)` filters array, returns array of message strings
- `.clear()` empties the array
- Buffer persists until explicitly cleared (allows multiple accesses)
- Extended loggers (via `.extend()`) inherit capture behavior

### Namespace Matching

Uses the same wildcard matching as the debug library:

- `*` matches any characters
- Namespaces are colon-separated: `gg:file:subnamespace`
- Filter string is matched against full namespace

## Example Use Case

Debugging WMO weather code grouping:

```typescript
import { gg } from '@leftium/gg';
const ggg = gg.persist;

// In lib/util.ts
const debug = ggg.extend('wmo');

function getGroupedWmoCode(hourlyData) {
	debug(
		'Input:',
		hourlyData.map((h) => h.weatherCode)
	);

	hourlyData.forEach((item, index) => {
		debug(`idx=${index} code=${item.weatherCode}`);
	});

	debug('Final result:', result);
	return result;
}

// After running, in DevTools console:
copy(ggg.log('*:wmo'));
// Clipboard now contains:
// Input: [3, 3, 3, 2, 1, 0, 0, 0]
// idx=0 code=3
// idx=1 code=3
// ...
// Final result: 3
```

### Filtering by Automatic Namespace

```typescript
// Logs are automatically namespaced by file and function
// In routes/+page.svelte, inside function handleClick:
ggg('clicked'); // ns: "gg:routes/+page.svelte@handleClick"

// In routes/TimeLine.svelte, inside $derived block:
ggg('derived'); // ns: "gg:routes/TimeLine.svelte"

// In lib/util.ts, inside function calculate:
ggg('calculating'); // ns: "gg:lib/util.ts@calculate"

// Filter examples:
copy(ggg.log('*+page*')); // All +page.svelte logs
copy(ggg.log('*TimeLine*')); // All TimeLine.svelte logs
copy(ggg.log('*util*')); // All util.ts logs
copy(ggg.log('*@handleClick*')); // All handleClick function logs
copy(ggg.log('gg:routes/*')); // All routes/ logs
copy(ggg.log('gg:lib/*')); // All lib/ logs
```

## Open Questions

1. **Raw vs formatted**: Should we store raw arguments or formatted output?
   - Raw: `['count:', 5, { foo: 'bar' }]` - format on access
   - Formatted: `"count: 5 { foo: 'bar' }"` - store as logged
   - Recommendation: Store formatted (what user sees in console)

2. **Include timestamps in output?**:
   - Include: `"+12ms gg:util.ts  message"` - matches console
   - Exclude: `"message"` - cleaner for sharing
   - Could be an option: `ggg.log({ timestamps: false })`

3. **Disabled behavior**: When gg is disabled, should persist still capture?
   - Yes: Useful for capturing without console noise
   - No: Consistent with gg behavior
   - Recommendation: No capture when disabled

## Server-Side Usage

`gg.persist` works in both browser and server environments (Node, Deno, Bun).

### Differences from Browser

| Feature       | Browser                       | Server           |
| ------------- | ----------------------------- | ---------------- |
| Global access | `globalThis.ggg` or DevTools  | `globalThis.ggg` |
| Clipboard     | `copy(ggg.log())` in DevTools | N/A              |
| Output        | `ggg.log()` returns string    | Same             |

### Server Examples

```typescript
import { gg } from '@leftium/gg';
const ggg = gg.persist;

// In your server code
ggg('request received', req.url);
ggg('processing', data);

// Access logs programmatically
console.log(ggg.log()); // Print to stdout
console.log(ggg.log('*:auth')); // Filter by namespace

// Write to file
import { writeFileSync } from 'fs';
writeFileSync('debug.log', ggg.log());
```

### Request Isolation (Future Consideration)

On the server, multiple requests may interleave logs. For v1, users can:

- Use `.clear()` between requests
- Filter by timestamp
- Use extended namespaces with request IDs: `ggg.extend(\`req-\${requestId}\`)`

Full request isolation may be added in a future version if needed.

## References

- [debug package](https://www.npmjs.com/package/debug) - underlying debug library with `extend()` method and wildcard matching
- Chrome DevTools `copy()` function - Command Line API, only available in DevTools console
