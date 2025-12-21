# Known Issues

## xterm.js Viewport Dimensions Error

**Console Error:**

```text
Uncaught TypeError: Cannot read properties of undefined (reading 'dimensions')
    at get dimensions
    at t2.Viewport.syncScrollArea
```

**Root Cause:** [xterm.js issue #5011](https://github.com/xtermjs/xterm.js/issues/5011)

**Details:**

- Affects xterm.js v5.3.0 - v5.4.0 (we use 5.3.0 via ink-web)
- Occurs during "aggressive re-rendering" when terminals inside containers are re-rendered frequently
- The Viewport tries to access `dimensions` before it's fully initialized
- **This is harmless** - the terminal functions correctly despite these console warnings

**Mitigations Applied:**

1. Delayed terminal mount by 200ms to allow DOM dimensions to stabilize (`App.tsx`)
2. Batched output updates using `requestAnimationFrame` to reduce re-render frequency (`useAgent.ts`)

**Status:** Waiting for fix in xterm.js upstream

**References:**

- <https://github.com/xtermjs/xterm.js/issues/5011>
- <https://github.com/xtermjs/xterm.js/issues/4775>

---

## ink-web Integration Notes

The TUI uses [ink-web](https://github.com/cjroth/ink-web) which enables Ink (React for CLI) to run in browsers using xterm.js.

Known limitations:

- xterm.js dimension errors (see above)
- Some xterm.js addons may not work properly in browser context
