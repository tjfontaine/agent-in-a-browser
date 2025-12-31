# @tjfontaine/wasm-loader

Core module registration system for lazy-loaded WASM commands.

## Overview

This package provides the infrastructure for registering and loading WASM modules on-demand. It defines the types and registry functions used by all `@tjfontaine/wasm-*` packages.

## Installation

```bash
npm install @tjfontaine/wasm-loader
```

## Usage

### Registering a Module

```typescript
import { registerModule, type ModuleRegistration } from '@tjfontaine/wasm-loader';

const myModule: ModuleRegistration = {
    name: 'my-module',
    commands: [
        { name: 'my-command', mode: 'buffered' },
    ],
    loader: async () => import('./my-module-wasm'),
};

registerModule(myModule);
```

### Checking Command Availability

```typescript
import { isRegisteredCommand, isInteractiveCommand, getCommandConfig } from '@tjfontaine/wasm-loader';

// Check if a command exists
if (isRegisteredCommand('vim')) {
    console.log('vim is available');
}

// Check command mode
if (isInteractiveCommand('vim')) {
    // Launch in TUI mode
}

// Get full config
const config = getCommandConfig('vim');
// { name: 'vim', mode: 'tui' }
```

### Loading Modules

```typescript
import { loadModuleForCommand } from '@tjfontaine/wasm-loader';

const module = await loadModuleForCommand('tsx');
if (module) {
    const handle = module.spawn('tsx', ['script.tsx'], env, stdin, stdout, stderr);
    const exitCode = await handle.resolve();
}
```

## API

### Types

| Type | Description |
|------|-------------|
| `CommandMode` | `'buffered' \| 'tui' \| 'both'` - Execution mode capability |
| `CommandConfig` | Command name and mode configuration |
| `ModuleMetadata` | Module name and commands (no loader) |
| `ModuleRegistration` | Metadata plus loader function |
| `CommandModule` | Interface for spawning commands |
| `InputStream` / `OutputStream` | WASI stream interfaces |

### Registry Functions

| Function | Description |
|----------|-------------|
| `registerModule(registration)` | Register a WASM module |
| `isRegisteredCommand(name)` | Check if command is available |
| `isInteractiveCommand(name)` | Check if command supports TUI mode |
| `isBufferedCommand(name)` | Check if command supports buffered mode |
| `getCommandConfig(name)` | Get command configuration |
| `getModuleForCommand(name)` | Get module name for command |
| `loadModuleForCommand(name)` | Load and return module |
| `getAllCommands()` | List all registered commands |
| `getAllModules()` | List all registered modules |

### Terminal Context

```typescript
import { setTerminalContext, isTerminalContext } from '@tjfontaine/wasm-loader';

// Set context before spawning
setTerminalContext(true);

// Check in command implementation
if (isTerminalContext()) {
    // Enable ANSI colors, etc.
}
```

## Design Pattern

This package separates **metadata** from **loaders**:

- **Metadata packages** (`@tjfontaine/wasm-tsx`, etc.) export only command info
- **Consuming application** provides the loader function
- This avoids Rollup trying to bundle dynamic WASM imports at build time

## License

MIT
