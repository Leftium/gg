# Case Study: Debugging ggConsole Scroll with gg File Sink

## Problem

When `GgConsole` (the Eruda-powered in-browser debug panel) was open, users could not scroll to the bottom of the page. The panel's fixed position covered the lower portion of the viewport with no way to reveal content behind it without closing the console entirely.

## Approach

The fix seemed straightforward: inject `padding-bottom` on `document.body` equal to the panel height when open, and remove it when closed — the same pattern TanStack Router devtools use. In practice, getting there required three debugging iterations. All three were completed **by the agent alone**, without any interaction from the developer beyond the initial reload request.

## The Iteration Loop — Agent-Driven Throughout

Each iteration followed the same autonomous cycle:

1. Add `gg()` diagnostics to the code
2. Ask the developer to reload (the one unavoidable human step — triggering browser execution)
3. Query `/__gg/logs` directly from the terminal
4. Read the output, diagnose the problem, write a fix
5. Repeat

The developer was not asked to open DevTools, inspect elements, copy/paste console output, describe what they saw, or answer diagnostic questions. The agent observed runtime browser state directly through the log endpoint.

---

### Iteration 1: Silent failure — no DOM elements found

The first implementation called `document.querySelector('.eruda-container')` to find the panel. After a reload, the agent queried the file sink:

```bash
curl -s http://localhost:5173/__gg/logs | jq 'select(.msg | test("setupBody"))'
# (empty)
```

No output at all — the `gg` calls weren't firing. The agent identified the cause without asking the developer: `window.gg` isn't how gg is exposed; it's a module export. The fix (pass `gg` as a function parameter) was written, and the next reload produced:

```
[setupBodyPadding] container: null  panel: null
```

Both null — Eruda uses shadow DOM by default (`useShadowDom: true`), so `document.querySelector` finds nothing inside the shadow root. Diagnosed entirely from the log output.

### Iteration 2: Container found, panel still null

After routing through `document.getElementById('eruda').shadowRoot`, the agent queried again:

```
[setupBodyPadding] container: [object HTMLDivElement]  panel: null
```

`container` was found. `._dev-tools` (the class name inferred from Eruda's minified source) was null. Rather than guess at the right name, the agent added a one-shot diagnostic to log the container's actual children, then read it:

```
[setupBodyPadding] container children: ["DIV#.eruda-dev-tools","DIV#.eruda-entry-btn"]
[setupBodyPadding] container.innerHTML snippet:
  <div class="eruda-dev-tools" style="height: 58.57%; ...">
```

The runtime class is `.eruda-dev-tools`. The fix was written immediately.

### Iteration 3: Timing — elements not yet in DOM

With the right selector, the agent queried again after the next reload and saw 20 polling attempts all returning `panel: null`. The pattern in the timestamps made the cause clear — `setupBodyPadding` was being called synchronously before Eruda had finished appending its shadow DOM. The agent added rAF-based polling, queried once more to confirm `panel` was now found, and the fix was complete.

**No developer input was needed at any of these diagnostic steps.** The developer's only involvement during the entire debug session was reloading the page when asked.

---

## What gg Made Possible

**The agent could observe live browser state from the terminal.** DOM queries, element class names, `offsetHeight` values, `scrollHeight` vs `innerHeight` — all of this runs in the browser, behind the viewport, invisible to static analysis. Without the file sink, the agent would have had to ask the developer to open DevTools, find the Elements panel, describe what they saw, and relay values back. Instead, the agent added `gg()` calls, read the results, and acted on them — the same way a developer would, but without the round-trip.

**Iteration was fast because there was no waiting.** Each cycle — write diagnostics, ask for reload, read logs, fix — took seconds of agent time. The bottleneck was the reload, not the debugging. In a normal back-and-forth, each diagnostic question to the developer costs at minimum a message exchange; here there were none.

**Exact runtime values, not reconstructions.** The `msg` field carried the actual serialized state: DOM element references, class names from the live shadow DOM, heights in pixels. The agent didn't have to reason about what Eruda's DOM _might_ look like — it read what was actually there.

**The file sink captured pre-UI output.** The very first diagnostic (`container: null`) was logged during page initialization, before the browser UI was visible. This kind of early-lifecycle data is what makes the file sink valuable over browser console screenshots — by the time a human looks at DevTools, the transient state is gone.

## Improvements Prompted by This Session

The debugging experience also surfaced gaps in the tooling that were fixed immediately:

| Gap                                  | Fix                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Objects log as `[object Object]`     | `formatValue()` added to `gg.ts` — objects serialize to compact JSON, DOM nodes to `tag#id.class` |
| Repeated rAF loop lines flood output | `collapseRepeats()` added to file sink HTTP endpoint; `?raw` opts out                             |
| Agent used `grep` instead of `jq`    | Global `AGENTS.md` updated with jq-first examples and a reminder to query gg proactively          |
| `?raw` undocumented                  | Added to README, spec template, and `/__gg/` index endpoint description                           |

The `[object Object]` issue was particularly relevant here: DOM nodes serialized as `[object HTMLDivElement]` rather than something like `div.eruda-container`. Even so, it was enough to confirm whether an element was found — and the innerHTML snippet filled in the rest. The improvements mean future sessions will get richer output without the extra diagnostic step.
