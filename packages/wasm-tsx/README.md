# @tjfontaine/wasm-tsx

TSX/TypeScript engine module metadata for the WASM shell.

## Overview

This package provides metadata for the TSX engine WASM module, which enables TypeScript and JavaScript execution in the browser sandbox. It exports command information used by the module loader system.

## Installation

```bash
npm install @tjfontaine/wasm-tsx
```

## Commands

| Command | Description | Mode |
|---------|-------------|------|
| `tsx` | Execute TypeScript/TSX files | buffered |
| `tsc` | TypeScript compiler (type checking) | buffered |

## Usage

### Metadata Only

```typescript
import { metadata } from '@tjfontaine/wasm-tsx';

console.log(metadata);
// {
//   name: 'tsx-engine',
//   commands: [
//     { name: 'tsx', mode: 'buffered' },
//     { name: 'tsc', mode: 'buffered' },
//   ]
// }
```

### With Registry

```typescript
import { metadata } from '@tjfontaine/wasm-tsx';
import { registerModule } from '@tjfontaine/wasm-loader';

registerModule({
    ...metadata,
    loader: () => import('../wasm/tsx-engine/tsx-engine.js'),
});
```

## Features

The underlying WASM module provides:

- **TypeScript transpilation** via SWC (Rust-based, fast)
- **ESM imports** resolved from esm.sh CDN
- **Node.js polyfills** for Buffer, URL, path, etc.
- **JSX/TSX support** out of the box

## Example

```bash
# In the web-agent shell
$ echo 'console.log("Hello, TypeScript!")' > hello.ts
$ tsx hello.ts
Hello, TypeScript!

$ tsx -e 'import { format } from "date-fns"; console.log(format(new Date(), "PPP"))'
December 31st, 2024
```

## Design Pattern

This package exports **metadata only**. The WASM binary is loaded by the consuming application to avoid bundler issues with dynamic imports.

## Related Packages

- `@tjfontaine/wasm-loader` - Core registry system
- `@tjfontaine/wasm-modules` - Aggregator for all modules

## License

MIT
