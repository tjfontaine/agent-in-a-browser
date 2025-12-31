# @tjfontaine/wasm-ratatui

Ratatui TUI demo module metadata for the WASM shell.

## Overview

This package provides metadata for the Ratatui demo WASM module, which includes several interactive TUI (Terminal User Interface) applications. These serve as demonstrations and utilities within the browser sandbox.

## Installation

```bash
npm install @tjfontaine/wasm-ratatui
```

## Commands

| Command | Description | Mode |
|---------|-------------|------|
| `ratatui-demo` | Main Ratatui demo application | tui |
| `tui-demo` | Alternative name for Ratatui demo | tui |
| `counter` | Simple counter TUI demo | tui |
| `ansi-demo` | ANSI escape code demonstration | tui |

## Usage

### Metadata Only

```typescript
import { metadata } from '@tjfontaine/wasm-ratatui';

console.log(metadata);
// {
//   name: 'ratatui-demo',
//   commands: [
//     { name: 'ratatui-demo', mode: 'tui' },
//     { name: 'tui-demo', mode: 'tui' },
//     { name: 'counter', mode: 'tui' },
//     { name: 'ansi-demo', mode: 'tui' },
//   ]
// }
```

### With Registry

```typescript
import { metadata } from '@tjfontaine/wasm-ratatui';
import { registerModule } from '@tjfontaine/wasm-loader';

registerModule({
    ...metadata,
    loader: () => import('../wasm/ratatui-demo/ratatui-demo.js'),
});
```

## Features

The underlying WASM module provides:

- **Interactive TUI applications** using Ratatui (Rust)
- **Terminal rendering** via ghostty-web
- **Keyboard input handling** with real-time updates
- **ANSI color support** for rich terminal output

## Example

```bash
# In the web-agent shell
$ counter       # Interactive counter with +/- buttons
$ ansi-demo     # Color and formatting showcase
$ tui-demo      # Full Ratatui demonstration
```

## TUI Mode

Commands in this package run in `tui` mode, meaning they:

- Take over the terminal display
- Handle keyboard input directly
- Render via ANSI escape sequences
- Cannot be piped to other commands

## Design Pattern

This package exports **metadata only**. The WASM binary is loaded by the consuming application when an interactive command is invoked.

## Related Packages

- `@tjfontaine/wasm-loader` - Core registry system
- `@tjfontaine/wasm-modules` - Aggregator for all modules
- `@tjfontaine/wasm-vim` - Vim editor (also TUI mode)

## License

MIT
