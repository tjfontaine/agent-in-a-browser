# @tjfontaine/wasm-modules

Aggregator package that re-exports all WASM module metadata.

## Overview

This package provides a convenient way to access metadata for all available WASM modules. It aggregates the metadata from individual packages (`wasm-tsx`, `wasm-sqlite`, `wasm-ratatui`, `wasm-vim`) and re-exports utilities from `wasm-loader`.

## Installation

```bash
npm install @tjfontaine/wasm-modules
```

## Usage

### Get All Module Metadata

```typescript
import { allMetadata, getAllCommandNames } from '@tjfontaine/wasm-modules';

// List all available commands
const commands = getAllCommandNames();
// ['tsx', 'tsc', 'sqlite3', 'vim', 'vi', 'edit', 'counter', 'tui-demo', ...]

// Access all metadata
for (const module of allMetadata) {
    console.log(`${module.name}: ${module.commands.map(c => c.name).join(', ')}`);
}
```

### Individual Module Metadata

```typescript
import { tsxMetadata, sqliteMetadata, ratatuiMetadata, vimMetadata } from '@tjfontaine/wasm-modules';

console.log(tsxMetadata.commands);
// [{ name: 'tsx', mode: 'buffered' }, { name: 'tsc', mode: 'buffered' }]
```

### Registry Functions (re-exported from wasm-loader)

```typescript
import {
    registerModule,
    isRegisteredCommand,
    isInteractiveCommand,
    loadModuleForCommand,
} from '@tjfontaine/wasm-modules';
```

## Included Modules

| Module | Commands | Mode |
|--------|----------|------|
| `tsx-engine` | `tsx`, `tsc` | buffered |
| `sqlite-module` | `sqlite3` | buffered |
| `edtui-module` | `vim`, `vi`, `edit` | tui |
| `ratatui-demo` | `counter`, `tui-demo`, `ansi-demo`, `ratatui-demo` | tui |

## Design Pattern

This package exports **metadata only**, not loaders. The consuming application registers modules with their own loader functions:

```typescript
import { allMetadata, registerModule } from '@tjfontaine/wasm-modules';

// Register each module with application-specific loaders
for (const meta of allMetadata) {
    registerModule({
        ...meta,
        loader: () => loadWasmModule(meta.name), // your loader
    });
}
```

## Exports

### Values

- `allMetadata` - Array of all module metadata
- `tsxMetadata`, `sqliteMetadata`, `ratatuiMetadata`, `vimMetadata` - Individual metadata

### Functions

- `getAllCommandNames()` - Get all command names across modules
- `getModuleMetadata(name)` - Get metadata for specific module
- All registry functions from `@tjfontaine/wasm-loader`

### Types

- `ModuleMetadata`, `ModuleRegistration`, `CommandConfig`, `CommandMode`
- `CommandModule`, `CommandHandle`, `ExecEnv`
- `InputStream`, `OutputStream`, `Pollable`

## License

MIT
