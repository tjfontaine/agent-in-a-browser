# MCP Bridge

WebSocket bridge to expose the browser's WASM MCP server to external agents like Claude Code.

## How It Works

```text
External Agent → stdio → MCP Bridge → WebSocket → Browser Sandbox
```

The bridge:

1. Listens on `ws://localhost:9999` for WebSocket connections
2. Reads MCP JSON-RPC requests from stdin
3. Forwards them to the connected browser client
4. Returns responses via stdout

## Quick Start

```bash
# Install and start the bridge
npm install
npm start

# Bridge is now listening on ws://localhost:9999
```

Then open [agent.edge-agent.dev/mcp-bridge.html](https://agent.edge-agent.dev/mcp-bridge.html) and click "Connect".

## Claude Code Integration

### One-Liner

Run Claude Code with all built-in tools disabled, forcing it to use the browser sandbox:

```bash
claude --tools "" --mcp-config '{"mcpServers": {"browser-sandbox": {"type": "http", "url": "http://localhost:3050/mcp"}}}'
```

This works because the bridge exposes a standard MCP HTTP endpoint compatible with Claude's config.

This forces Claude to use the browser sandbox for all file and shell operations.

### 3. Connect browser

Open the MCP Bridge page and connect before sending messages to Claude.

## Protocol

The bridge uses a simple ID-prefixed protocol:

```text
→ REQ_123:tools/call:shell_eval:{"command":"ls"}
← RES_123:{"result":"file1.ts\nfile2.ts"}
```

See [index.ts](./index.ts) for implementation details.
