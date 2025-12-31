# WASM Bridge Layer

This directory contains the browser-side infrastructure that connects the WASM MCP server to browser APIs.

## Architecture Overview

```text
                       ┌──────────────────────────────────────────────┐
                       │             Web Worker Context               │
                       │                                              │
   SandboxWorker.ts    │   ┌──────────────────────────────────────┐  │
          │            │   │   WASM MCP Server (jco-transpiled)   │  │
          │            │   │                                       │  │
          ▼            │   │  Imports these WIT interfaces:       │  │
   WasmBridge.ts ──────┼──►│  - wasi:filesystem/*                 │  │
          │            │   │  - wasi:http/outgoing-handler        │  │
          │            │   │  - wasi:clocks/*                     │  │
          │            │   │  - mcp:module-loader/loader          │  │
          │            │   │                                       │  │
          │            │   │  Exports:                            │  │
          │            │   │  - wasi:http/incoming-handler        │  │
          │            │   │  - shell:unix/command                │  │
          │            │   └─────────┬───────────────┬────────────┘  │
          │            │             │               │                │
          │            │             ▼               ▼                │
          │            │   ┌─────────────────┐  ┌─────────────────┐  │
          │            │   │opfs-filesystem  │  │wasi-http        │  │
          │            │   │-impl.ts         │  │-impl.ts         │  │
          │            │   │                 │  │                 │  │
          │            │   │ SyncAccessHandle│  │ Transport to    │  │
          │            │   │ + OPFS tree     │  │ sandbox worker  │  │
          │            │   └─────────────────┘  └─────────────────┘  │
          │            │                                              │
          │            │   ┌────────────────────────────────────┐    │
          │            │   │ clocks-impl.js                     │    │
          │            │   │ Custom Pollable with busy-wait     │    │
          │            │   └────────────────────────────────────┘    │
          └────────────┴──────────────────────────────────────────────┘
```

## Directory Contents

### Generated Code (do not edit manually)

| Directory | Description |
|-----------|-------------|
| `mcp-server-jspi/` | jco-transpiled MCP server for Chrome (JSPI mode) |
| `mcp-server-sync/` | jco-transpiled MCP server for Safari/Firefox (sync mode) |
| `tsx-engine/` | jco-transpiled TypeScript execution module |
| `sqlite-module/` | jco-transpiled SQLite database module |
| `ratatui-demo/` | jco-transpiled Ratatui demo TUI |
| `web-agent-tui/` | jco-transpiled main Ratatui TUI application |

### Lazy Loading Infrastructure

| File | Purpose |
|------|---------|
| `lazy-modules.ts` | On-demand loading of heavy modules (tsx, sqlite, git) |
| `module-loader-impl.ts` | Module instantiation with WASI imports, LazyProcess spawning |
| `async-mode.ts` | JSPI detection and dynamic MCP server loading |

### TUI Integration

| File | Purpose |
|------|---------|
| `tui-loader.ts` | Connects ghostty-web terminal to Ratatui WASM TUI |
| `ghostty-cli-shim.ts` | Bridges terminal stdin/stdout to WASI I/O |

### Host Bridge Implementations

| File | WASI Interface | Purpose |
|------|----------------|---------|
| `opfs-filesystem-impl.ts` | `wasi:filesystem/*` | Sync filesystem via SyncAccessHandle + lazy-loaded directory tree |
| `opfs-async-helper.ts` | N/A | Helper worker for async OPFS operations (SharedArrayBuffer bridge) |
| `opfs-sync-bridge.ts` | N/A | Synchronous file I/O via Atomics + binary data handling |
| `directory-tree.ts` | N/A | OPFS directory structure and file metadata |
| `wasi-http-impl.ts` | `wasi:http/outgoing-handler` | HTTP via transport handler (routes to sandbox worker) |
| `clocks-impl.js` | `wasi:clocks/*` | Custom Pollable extensions for sync blocking |

### Git Integration

| File | Purpose |
|------|---------|
| `git-module.ts` | isomorphic-git integration for git commands |
| `opfs-git-adapter.ts` | Adapts OPFS to isomorphic-git's fs interface |
| `symlink-store.ts` | Symlink persistence via IndexedDB |

### Stream Classes

| File | Purpose |
|------|---------|
| `streams.ts` | Custom WASI stream classes (InputStream, OutputStream, ReadyPollable) |

## How It Works

### 1. TUI Application Flow

```text
main-tui.ts → tui-loader.ts → ghostty-web terminal
                    ↓
            web-agent-tui.wasm (Ratatui TUI)
                    ↓
            shell:unix/command → ts-runtime-mcp.wasm
```

The Ratatui TUI runs as a WASM component, rendering via ANSI escape sequences to the ghostty terminal. User input flows from ghostty through the CLI shim to the TUI's stdin.

### 2. MCP Tool Request Flow

```text
Ratatui TUI → HTTP POST → WasmBridge → WASM MCP Server → Tool Result
```

When the TUI needs to execute a tool, it makes an HTTP request that's routed through the WasmBridge to the MCP server WASM component.

### 3. File System Bridge (Lazy Loading)

The WASM component uses standard `wasi:filesystem` via `std::fs` in Rust. Our `opfs-filesystem-impl.ts` bridges this to the browser:

1. **SyncAccessHandle** - File I/O via synchronous OPFS handles (Web Worker only)
2. **Lazy-loaded directory tree** - Directories are scanned on first access, not at startup
3. **SharedArrayBuffer + Atomics** - True synchronous blocking via helper worker
4. **Session isolation** - Sandbox starts with minimal state, builds as needed

```text
┌─────────────────────┐         ┌────────────────────────┐
│   Sandbox Worker    │         │   Async Helper Worker  │
│   (runs WASM)       │  SAB    │   (handles async OPFS) │
│                     │◄───────►│                        │
│  Atomics.wait()     │         │  Atomics.notify()      │
└─────────────────────┘         └────────────────────────┘
```

### 4. HTTP Bridge

HTTP requests use `wasi:http/outgoing-handler` implemented in `wasi-http-impl.ts`:

- Uses a **transport handler** that routes requests to the sandbox worker
- Constructs proper WASI HTTP types (`OutgoingRequest`, `IncomingResponse`, etc.)
- Returns streaming responses via ReadableStream

## Build Process

1. **Rust compilation** (in `runtime/`):

   ```bash
   cargo component build --release --target wasm32-wasip2
   ```

2. **jco transpilation** (in `frontend/`):

   ```bash
   npm run transpile:all
   ```

   This generates the WASM module directories with interface mappings:

   ```text
   --map 'wasi:filesystem/*=../opfs-filesystem-impl.js#*'
   --map 'wasi:http/types=../wasi-http-impl.js'
   --map 'wasi:http/outgoing-handler=../wasi-http-impl.js#outgoingHandler'
   --map 'wasi:clocks/*=../clocks-impl.js#*'
   --map 'mcp:module-loader/loader=../module-loader-impl.js'
   ...
   ```

3. **Vite bundles** everything for the browser

## Updating Host Bridges

When modifying `opfs-filesystem-impl.ts` or `wasi-http-impl.ts`:

1. **Match the WASI interface** - Functions must match standard WASI signatures
2. **Keep it synchronous** - The WASM component expects sync responses (we run in a Web Worker)
3. **Handle resources properly** - WASI uses resource handles, implement `[Symbol.dispose]` when needed

## Related Documentation

- [Runtime README](../../../runtime/README.md) - Rust MCP server
- [WIT Interfaces](../../../runtime/wit/world.wit) - Interface definitions
