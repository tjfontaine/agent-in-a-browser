# @tjfontaine/browser-mcp-runtime

Meta-package for running MCP servers in the browser.

## Features

- **One-line setup** with `initializeMcpRuntime()`
- **Re-exports** all @tjfontaine packages
- **Browser detection** for JSPI support

## Usage

```typescript
import { initializeMcpRuntime, supportsJSPI } from '@tjfontaine/browser-mcp-runtime';

// Initialize everything
await initializeMcpRuntime();

// Check JSPI support
console.log('JSPI:', supportsJSPI());
```

## Included Packages

- `@tjfontaine/wasi-http-handler` - Fetch-based HTTP
- `@tjfontaine/wasi-shims` - WASI shims (OPFS filesystem, clocks, streams)
- `@tjfontaine/mcp-wasm-server` - MCP runtime

## License

MIT
