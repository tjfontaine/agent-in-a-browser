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

### 1. Create MCP config

Create a file `mcp.json`:

```json
{
  "mcpServers": {
    "browser-sandbox": {
      "command": "npx",
      "args": ["tsx", "tools/mcp-bridge/index.ts"]
    }
  }
}
```

### 2. Run Claude Code with disabled tools

```bash
claude --mcp-config mcp.json \
  --disable-tool bash \
  --disable-tool computer \
  --disable-tool edit \
  --disable-tool glob \
  --disable-tool grep \
  --disable-tool ls \
  --disable-tool read \
  --disable-tool write
```

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
