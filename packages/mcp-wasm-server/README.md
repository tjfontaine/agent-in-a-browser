# @tjfontaine/mcp-wasm-server

MCP (Model Context Protocol) server with WASM runtime.

## Features

- **JSPI detection** for optimal async performance
- **Lazy module loading** for tsx-engine, sqlite, git
- **Prebuilt WASM** binaries included

## Usage

```typescript
import { loadMcpServer, hasJSPI, getIncomingHandler } from '@tjfontaine/mcp-wasm-server';

// Load MCP server (auto-selects JSPI or sync mode)
await loadMcpServer();

// Get incoming handler for MCP requests
const handler = getIncomingHandler();
```

## Lazy Modules

Heavy modules are loaded on-demand:

- `tsx-engine` - TypeScript execution
- `sqlite-module` - SQLite database
- `git-module` - Git operations

## License

MIT
