# Frontend Source Code

This directory contains the browser-based TUI for the Web Agent.

## Architecture Overview

The frontend is a thin TypeScript layer that connects ghostty-web (a WebGL terminal emulator) to a Ratatui-based TUI running as a WASM component.

```text
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                        │
│                                                                 │
│  ┌─────────────────────┐                                        │
│  │ main-tui.ts         │  Entry point                           │
│  │   └── tui-loader.ts │  Initializes ghostty + Ratatui WASM    │
│  └──────────┬──────────┘                                        │
│             │                                                   │
│  ┌──────────▼──────────┐   ┌────────────────────────────────┐   │
│  │ ghostty-web         │   │ web-agent-tui.wasm (Ratatui)   │   │
│  │ (WebGL Terminal)    │◄──│ - 100% Rust TUI               │   │
│  │                     │   │ - All UI rendered via ANSI     │   │
│  └─────────────────────┘   └───────────────┬────────────────┘   │
│                                            │                    │
│  ┌─────────────────────────────────────────▼────────────────┐   │
│  │ Sandbox Worker (Web Worker)                              │   │
│  │ - ts-runtime-mcp.wasm (MCP Server + Shell + AI)          │   │
│  │ - OPFS File System                                       │   │
│  │ - tsx-engine.wasm, sqlite-module.wasm (lazy loaded)      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```text
src/
├── main-tui.ts             # Entry point - mounts terminal
├── index.css               # Minimal base styles
├── vite-env.d.ts           # Vite type declarations
│
├── agent/                  # Agent helpers
│   └── sandbox.ts          # Sandbox worker management
│
├── mcp/                    # MCP bridge
│   ├── Client.ts           # MCP type definitions
│   └── WasmBridge.ts       # WASM MCP server bridge
│
├── workers/                # Web Workers
│   ├── SandboxWorker.ts    # Main sandbox (loads WASM MCP server)
│   ├── Fetch.ts            # Worker-based fetch helper
│   └── Fetch.test.ts       # Tests
│
└── wasm/                   # WASM runtime implementations
    ├── tui-loader.ts       # Connects ghostty to Ratatui WASM
    ├── ghostty-cli-shim.ts # Terminal stdin/stdout bridge
    ├── async-mode.ts       # JSPI detection + MCP server loading
    ├── lazy-modules.ts     # Lazy loading for tsx/sqlite/git
    │
    ├── opfs-filesystem-impl.ts  # WASI filesystem on OPFS
    ├── directory-tree.ts        # OPFS directory operations
    ├── opfs-sync-bridge.ts      # Sync ops via SharedArrayBuffer
    ├── opfs-async-helper.ts     # Async worker for OPFS
    │
    ├── wasi-http-impl.ts   # WASI HTTP implementation
    ├── streams.ts          # Custom WASI stream classes
    ├── symlink-store.ts    # Symlink persistence (IndexedDB)
    │
    ├── git-module.ts       # isomorphic-git integration
    ├── opfs-git-adapter.ts # Git filesystem adapter
    ├── module-loader-impl.ts    # Lazy command spawning
    │
    └── [generated]/        # jco-transpiled WASM modules
        ├── mcp-server-jspi/
        ├── mcp-server-sync/
        ├── tsx-engine/
        ├── sqlite-module/
        ├── ratatui-demo/
        └── web-agent-tui/
```

## Key Concepts

### Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `main-tui.ts` | Entry point, mounts ghostty terminal |
| `tui-loader.ts` | Initializes sandbox, OPFS, runs Ratatui WASM |
| `ghostty-cli-shim.ts` | Bridges terminal I/O to WASM stdin/stdout |
| `SandboxWorker.ts` | Web Worker hosting MCP server WASM |
| `WasmBridge.ts` | Routes HTTP requests to WASM MCP handler |

### Data Flow

1. `main-tui.ts` creates a full-screen ghostty terminal
2. `tui-loader.ts` initializes OPFS, sandbox worker, and runs `web-agent-tui.wasm`
3. Ratatui TUI runs in WASM, rendering via ANSI escape sequences
4. User input flows: ghostty → `ghostty-cli-shim.ts` → WASI stdin
5. TUI output flows: WASI stdout → `ghostty-cli-shim.ts` → ghostty canvas
6. AI/tool calls: Ratatui WASM → HTTP → `WasmBridge.ts` → `ts-runtime-mcp.wasm`

### JSPI vs Sync Mode

- **Chrome (JSPI)**: True async suspension - modules load on demand
- **Safari/Firefox (Sync)**: Eager loading at startup, synchronous execution

## Development

```bash
# Start development server
npm run dev

# Build for production  
npm run build

# Run unit tests
npm test

# Run E2E tests (requires Playwright)
npm run test:e2e
```
