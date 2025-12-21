# Frontend Source Code

This directory contains the browser-based AI agent application.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│  ┌──────────────────┐  ┌───────────────────────────────────┐│
│  │ Terminal UI      │  │ Agent                              ││
│  │ (xterm.js)       │  │ - Vercel AI SDK                   ││
│  │                  │  │ - MCP Tool Integration            ││
│  └────────┬─────────┘  └────────────────┬──────────────────┘│
│           │                              │                   │
│  ┌────────▼─────────────────────────────▼──────────────────┐│
│  │ Sandbox Worker (Web Worker)                              ││
│  │ - WASM MCP Server                                        ││
│  │ - OPFS File System                                       ││
│  │ - TypeScript Execution                                   ││
│  └──────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/
├── main.ts                 # Entry point - orchestrates initialization
├── types.ts                # Shared type definitions
├── constants.ts            # Configuration constants
├── system-prompt.ts        # AI agent system prompt
│
├── terminal/               # Terminal UI layer
│   ├── index.ts            # Barrel export
│   ├── setup.ts            # xterm.js configuration and addons
│   └── welcome.ts          # Welcome banner
│
├── commands/               # Slash command handling
│   ├── index.ts            # Barrel export
│   ├── router.ts           # Command routing (/help, /clear, etc.)
│   └── mcp.ts              # MCP server management commands
│
├── agent/                  # Agent execution
│   ├── index.ts            # Barrel export
│   ├── loop.ts             # Agent execution loop
│   ├── sandbox.ts          # Sandbox worker management
│   └── status.ts           # Status display
│
├── input/                  # Input handling
│   ├── index.ts            # Barrel export
│   └── prompt-loop.ts      # Readline prompt loop
│
├── tui.ts                  # TUI components (spinners, diffs)
├── agent-sdk.ts            # Vercel AI SDK integration
├── command-parser.ts       # Slash command parser
├── mcp-client.ts           # MCP JSON-RPC client
├── wasm-mcp-bridge.ts      # WASM MCP bridge
├── oauth-pkce.ts           # OAuth 2.1 PKCE authentication
├── remote-mcp-registry.ts  # Remote MCP server registry
├── sandbox-worker.ts       # Web Worker entry point
│
└── wasm/                   # WASM runtime
    ├── ts-runtime.ts       # TypeScript runtime loader
    ├── opfs-filesystem-impl.ts  # OPFS file system
    ├── wasi-http-impl.ts   # WASI HTTP implementation
    ├── clocks-impl.js      # Custom clocks for sync blocking
    └── mcp-server/         # Generated WASM MCP server
```

## Key Concepts

### Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `terminal/` | xterm.js setup, welcome banner, key handlers |
| `commands/` | Slash command parsing and execution |
| `agent/` | AI agent lifecycle and sandbox communication |
| `input/` | User input handling and prompt loop |

### Data Flow

1. User types in terminal
2. `input/prompt-loop.ts` receives input
3. If `/command`, routes to `commands/router.ts`
4. If message, routes to `agent/loop.ts`
5. Agent calls tools via `agent/sandbox.ts` → WASM MCP server
6. Results rendered via `tui.ts`

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation |
| `/files` | List files in sandbox |
| `/mcp` | Show MCP server status |
| `/mcp add <url>` | Add remote MCP server |
| `/mcp auth <id>` | Authenticate with OAuth |
| `/mcp connect <id>` | Connect to server |

## Development

```bash
# Start development server
npm run dev

# Build for production
npm run build
```

## Adding New Commands

1. Add command definition to `command-parser.ts`
2. Add handler case in `commands/router.ts`
3. For complex commands, create a new file in `commands/`
