# @tjfontaine/wasi-shims

WASI shims for clocks, streams, and terminal info.

## Features

- **Custom Pollable** with busy-wait for sync mode
- **InputStream/OutputStream** classes for WASI I/O
- **Terminal info** for TUI applications

## Usage

```typescript
import { clocks, InputStream, OutputStream } from '@tjfontaine/wasi-shims';

// Get current time
const now = clocks.wallClock.now();
```

## WASI Interface

Implements `wasi:clocks/*` for use with jco-transpiled WASM components.

## License

MIT
