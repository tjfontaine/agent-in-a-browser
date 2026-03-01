# @tjfontaine/edge-agent-sdk

SDK for embedding Edge Agent sandboxes in third-party websites. Boots a WASM MCP sandbox in the browser and connects it to the cloud relay so server-side agents (like Claude Code) can execute tools remotely.

## Overview

The SDK handles:

1. **Sandbox boot** — Initializes the WASM MCP runtime (OPFS filesystem, shell, TypeScript, SQLite)
2. **Tool discovery** — Queries the sandbox for available MCP tools
3. **Relay connection** — Connects to the cloud relay via WebSocket with auto-reconnect
4. **Status reporting** — Sends readiness and tool list to the relay

## Install

```sh
pnpm add @tjfontaine/edge-agent-sdk
```

If using the built-in sandbox boot (no custom `sandboxFetch`), also install:

```sh
pnpm add @tjfontaine/browser-mcp-runtime
```

## Usage

```typescript
import { EdgeAgentSandbox } from '@tjfontaine/edge-agent-sdk';

const sandbox = new EdgeAgentSandbox({
  sessionId: 'abc123',
  tenantId: 'acme',
  sessionToken: 'st_abc123_xxx', // optional, for deployer-created sessions
  onStateChange: (state) => console.log('Sandbox:', state),
  onRelayStateChange: (state) => console.log('Relay:', state),
});

// Boot WASM runtime, discover tools, connect to relay
await sandbox.initialize();

// Wait for ready
sandbox.onReady(() => {
  console.log('Tools available at', sandbox.mcpUrl);
  console.log('Browser URL:', sandbox.browserUrl);
});

// Cleanup
sandbox.destroy();
```

### Custom Sandbox

If you already have a WASM sandbox running, provide your own fetch function:

```typescript
const sandbox = new EdgeAgentSandbox({
  sessionId: 'abc123',
  tenantId: 'acme',
  sandboxFetch: async (input, init) => {
    // Route to your existing MCP server
    return myMcpServer.fetch(input, init);
  },
});
```

## States

| State | Description |
|-------|-------------|
| `idle` | Created, not yet initialized |
| `initializing` | Booting WASM runtime and connecting |
| `ready` | Sandbox running, relay connected |
| `error` | Initialization failed |
| `destroyed` | Resources released |

## Exports

- `EdgeAgentSandbox` — Main class
- `RelayClient` — Re-exported from `@tjfontaine/edge-agent-session`
- Types: `EdgeAgentSandboxOptions`, `SandboxState`, `RelayClientOptions`, `RelayState`, `SandboxFetch`

## Related Packages

- `@tjfontaine/edge-agent-session` — Shared types, URL builders, relay client
- `@tjfontaine/browser-mcp-runtime` — WASM MCP runtime (optional peer dependency)
- `@tjfontaine/edge-agent-mcp` — CLI bridge for connecting Claude Code to the sandbox

## License

MIT
