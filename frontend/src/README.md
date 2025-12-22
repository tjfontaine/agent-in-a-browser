# Frontend Source Code

This directory contains the browser-based AI agent application.

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                    │
│  ┌──────────────────┐  ┌───────────────────────────────────┐│
│  │ React App        │  │ Agent (useAgent hook)             ││
│  │ (ink-web/xterm)  │  │ - Vercel AI SDK                   ││
│  │                  │  │ - MCP Tool Integration            ││
│  └────────┬─────────┘  └────────────────┬──────────────────┘│
│           │                             │                   │
│  ┌────────▼─────────────────────────────▼──────────────────┐│
│  │ Sandbox Worker (Web Worker)                             ││
│  │ - WASM MCP Server                                       ││
│  │ - OPFS File System                                      ││
│  │ - TypeScript Execution                                  ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```text
src/
├── main.tsx                # React entry point
├── App.tsx                 # Main application component
├── index.css               # Global styles
│
├── types.ts                # Shared type definitions
├── constants.ts            # Configuration constants
├── system-prompt.ts        # AI agent system prompt
│
├── components/             # React components
│   ├── SplitLayout.tsx     # Main/auxiliary panel layout
│   ├── AuxiliaryPanel.tsx  # Task/file/output panel
│   ├── auxiliary-panel-context.tsx
│   └── ui/                 # Reusable UI components
│       ├── text-input.tsx  # Terminal text input
│       ├── Spinner.tsx     # Loading spinner
│       └── ...
│
├── agent/                  # Agent execution
│   ├── index.ts            # Barrel export
│   ├── useAgent.ts         # React hook for agent state
│   ├── loop.ts             # Agent execution loop
│   ├── sandbox.ts          # Sandbox worker management
│   └── status.ts           # Status display
│
├── commands/               # Slash command handling
│   ├── index.ts            # Barrel export
│   ├── router.ts           # Command routing (/help, /clear, etc.)
│   └── mcp.ts              # MCP server management commands
│
├── tui.ts                  # TUI components (spinners, diffs)
├── task-manager.ts         # Task state management
├── agent-sdk.ts            # Vercel AI SDK integration
├── command-parser.ts       # Slash command parser
├── mcp-client.ts           # MCP JSON-RPC client
├── wasm-mcp-bridge.ts      # WASM MCP bridge
├── worker-fetch.ts         # Worker-based fetch wrapper
├── oauth-pkce.ts           # OAuth 2.1 PKCE authentication
├── remote-mcp-registry.ts  # Remote MCP server registry
├── sandbox-worker.ts       # Web Worker entry point
│
└── wasm/                   # WASM runtime
    ├── opfs-filesystem-impl.ts  # OPFS file system
    ├── wasi-http-impl.ts   # WASI HTTP implementation
    ├── clocks-impl.js      # Custom clocks for sync blocking
    └── mcp-server/         # Generated WASM MCP server
```

## Key Concepts

### Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `App.tsx` | Main React component with terminal UI |
| `components/` | React components for UI layout |
| `agent/useAgent.ts` | React hook managing agent state |
| `commands/` | Slash command parsing and execution |
| `agent/` | AI agent lifecycle and sandbox communication |

### Data Flow

1. User types in terminal (ink-web TextInput)
2. `App.tsx` handles input via `handleSubmit`
3. If `/command`, routes to `commands/router.ts`
4. If message, calls `sendMessage` from `useAgent` hook
5. Agent calls tools via `agent/sandbox.ts` → WASM MCP server
6. Results rendered as React components in terminal

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

# Run tests
npm test

# Build for production
npm run build
```

## Adding New Commands

1. Add command definition to `command-parser.ts`
2. Add handler case in `commands/router.ts`
3. For complex commands, create a new file in `commands/`
