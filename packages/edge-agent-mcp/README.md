# @tjfontaine/edge-agent-mcp

MCP bridge for Edge Agent — connects Claude Code, headless agents, and CI pipelines to a browser WASM sandbox via the Model Context Protocol.

## Overview

This CLI tool speaks MCP over stdio and forwards tool calls to an Edge Agent sandbox. It supports three execution modes:

| Mode | How it works | Best for |
|------|-------------|----------|
| **cloud** | Forwards requests via HTTPS to the cloud relay | Easiest setup, works anywhere |
| **local** | Connects via WebSocket to a browser on localhost | Low-latency local development |
| **headless** | Spawns `wasm-tui --mcp-stdio` natively via wasmtime | CI/CD, no browser needed |
| **auto** | Tries headless -> local -> cloud | Recommended default |

## Quick Start

### Add to Claude Code

```sh
claude mcp add edge-agent -- npx @tjfontaine/edge-agent-mcp
```

Then open your session URL in a browser to connect the sandbox.

### First-Time Setup

```sh
npx @tjfontaine/edge-agent-mcp setup
```

This generates a session ID and saves config to `~/.edge-agent/config.toml`.

## Usage

```sh
# Run with auto-detected mode (default)
npx @tjfontaine/edge-agent-mcp

# Override mode
npx @tjfontaine/edge-agent-mcp --mode cloud
npx @tjfontaine/edge-agent-mcp --mode headless

# Override session
npx @tjfontaine/edge-agent-mcp --session abc123 --tenant acme

# Show current config
npx @tjfontaine/edge-agent-mcp status
```

## Available Tools

When connected, the sandbox exposes these MCP tools:

- `shell_eval` — Execute shell commands (50+ POSIX commands, pipes, redirects)
- `read_file` / `write_file` — Filesystem access
- `edit_file` — Search-and-replace file editing
- `list` — Directory listing
- `grep` — Pattern search across files

All execution happens client-side in the browser sandbox — no data leaves the user's machine.

## Configuration

Config is stored in `~/.edge-agent/config.toml`:

```toml
session = "abc123..."
tenant_id = "personal"
mode = "auto"

[cloud]
relay_base = "edge-agent.dev"

[local]
ws_port = 3040

[headless]
work_dir = "~/.edge-agent/sandbox"
```

## Claude Desktop / JSON Config

```json
{
  "mcpServers": {
    "edge-agent": {
      "command": "npx",
      "args": ["@tjfontaine/edge-agent-mcp"]
    }
  }
}
```

Or use HTTP transport directly:

```json
{
  "mcpServers": {
    "edge-agent": {
      "url": "https://{sid}.{tenantId}.sessions.edge-agent.dev/mcp"
    }
  }
}
```

## Related Packages

- `@tjfontaine/edge-agent-session` — Shared types, URL builders, relay client
- `@tjfontaine/edge-agent-sdk` — SDK for embedding sandboxes in websites
- `@tjfontaine/browser-mcp-runtime` — WASM MCP runtime for browsers

## License

MIT
