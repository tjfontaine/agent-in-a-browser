# @tjfontaine/wasm-vim

Vim-style editor module metadata for the WASM shell.

## Overview

This package provides metadata for the edtui (editor TUI) WASM module, which implements a Vim-style text editor in the browser sandbox. Built on the edtui Rust crate, it provides modal editing with familiar Vim keybindings.

## Installation

```bash
npm install @tjfontaine/wasm-vim
```

## Commands

| Command | Description | Mode |
|---------|-------------|------|
| `vim` | Vim-style text editor | tui |
| `vi` | Alias for vim | tui |
| `edit` | Alias for vim | tui |

## Usage

### Metadata Only

```typescript
import { metadata } from '@tjfontaine/wasm-vim';

console.log(metadata);
// {
//   name: 'edtui-module',
//   commands: [
//     { name: 'vim', mode: 'tui' },
//     { name: 'vi', mode: 'tui' },
//     { name: 'edit', mode: 'tui' },
//   ]
// }
```

### With Registry

```typescript
import { metadata } from '@tjfontaine/wasm-vim';
import { registerModule } from '@tjfontaine/wasm-loader';

registerModule({
    ...metadata,
    loader: () => import('../wasm/edtui-module/edtui-module.js'),
});
```

## Features

The underlying WASM module provides:

- **Modal editing** (Normal, Insert, Visual, Command modes)
- **Vim keybindings** (hjkl navigation, dd, yy, p, etc.)
- **File operations** (:w, :q, :wq, :q!)
- **Search** with `/` and `n`/`N` navigation
- **Syntax highlighting** via syntect
- **OPFS integration** for persistent file storage

## Example

```bash
# In the web-agent shell
$ vim myfile.txt    # Open or create file
$ vi script.ts      # Edit TypeScript file
$ edit notes.md     # Edit markdown file
```

## Vim Keybindings

| Mode | Keys | Action |
|------|------|--------|
| Normal | `i` | Enter Insert mode |
| Normal | `v` | Enter Visual mode |
| Normal | `:` | Enter Command mode |
| Normal | `hjkl` | Navigate |
| Normal | `dd` | Delete line |
| Normal | `yy` | Yank line |
| Normal | `p` | Paste |
| Normal | `/` | Search |
| Normal | `n`/`N` | Next/previous match |
| Insert | `Esc` | Return to Normal mode |
| Command | `:w` | Save |
| Command | `:q` | Quit |
| Command | `:wq` | Save and quit |

## TUI Mode

This editor runs in `tui` mode:

- Takes over the full terminal display
- Handles keyboard input directly
- Renders via ANSI escape sequences
- Cannot be piped to other commands

## Design Pattern

This package exports **metadata only**. The WASM binary is loaded by the consuming application when the editor is invoked.

## Related Packages

- `@tjfontaine/wasm-loader` - Core registry system
- `@tjfontaine/wasm-modules` - Aggregator for all modules
- `@tjfontaine/wasm-ratatui` - Other TUI applications

## License

MIT
