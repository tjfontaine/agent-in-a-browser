# WASM Bridge Layer

This directory contains the browser-side infrastructure that connects the WASM MCP server to browser APIs.

## Architecture Overview

```text
                       ┌──────────────────────────────────────────────┐
                       │             Web Worker Context               │
                       │                                              │
   sandbox-worker.ts   │   ┌──────────────────────────────────────┐  │
          │            │   │   WASM MCP Server (jco-transpiled)   │  │
          │            │   │                                       │  │
          ▼            │   │  Imports these WIT interfaces:       │  │
   mcp-client.ts ──────┼──►│  - wasi:filesystem/*                 │  │
          │            │   │  - wasi:http/outgoing-handler        │  │
          │            │   │  - wasi:clocks/*                     │  │
          │            │   │                                       │  │
          │            │   │  Exports:                            │  │
          │            │   │  - wasi:http/incoming-handler        │  │
          │            │   └─────────┬───────────────┬────────────┘  │
          │            │             │               │                │
          │            │             ▼               ▼                │
          │            │   ┌─────────────────┐  ┌─────────────────┐  │
          │            │   │opfs-filesystem  │  │wasi-http        │  │
          │            │   │-impl.ts         │  │-impl.ts         │  │
          │            │   │                 │  │                 │  │
          │            │   │ SyncAccessHandle│  │ Sync XHR for    │  │
          │            │   │ + in-memory tree│  │ HTTP requests   │  │
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
| `mcp-server/` | jco-transpiled WASM component (ES modules) |

### Host Bridge Implementations

| File | WASI Interface | Purpose |
|------|----------------|---------|
| `opfs-filesystem-impl.ts` | `wasi:filesystem/*` | Sync filesystem via SyncAccessHandle + lazy-loaded directory tree |
| `opfs-async-helper.ts` | N/A | Helper worker for async OPFS operations (SharedArrayBuffer bridge) |
| `wasi-http-impl.ts` | `wasi:http/outgoing-handler` | Sync HTTP via XMLHttpRequest |
| `clocks-impl.js` | `wasi:clocks/*` | Custom Pollable extensions for sync blocking |

## How It Works

### 1. MCP Request Flow

```text
Agent → MCP Client → postMessage → Worker → WASM Component → Tool Result
```

The AI agent (Vercel AI SDK) sends MCP JSON-RPC requests. The `mcp-client.ts` in the main thread forwards these via `postMessage` to the Web Worker. The worker invokes the WASM component's HTTP handler, which processes the request and returns results.

### 2. File System Bridge (Lazy Loading)

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

### 3. HTTP Bridge

HTTP requests use standard `wasi:http/outgoing-handler` implemented in `wasi-http-impl.ts`:

- Uses **synchronous XMLHttpRequest** to block the WASM module (deprecated but necessary)
- Constructs proper WASI HTTP types (`OutgoingRequest`, `IncomingResponse`, etc.)
- Returns immediately-resolved `FutureIncomingResponse` for sync semantics

## Build Process

1. **Rust compilation** (in `runtime/`):

   ```bash
   cargo component build --release --target wasm32-wasip2
   ```

2. **jco transpilation** (in `frontend/`):

   ```bash
   npm run transpile:component
   ```

   This generates `mcp-server/` with interface mappings:

   ```text
   --map 'wasi:filesystem/*=../opfs-filesystem-impl.js#*'
   --map 'wasi:http/types=../wasi-http-impl.js'
   --map 'wasi:http/outgoing-handler=../wasi-http-impl.js#outgoingHandler'
   --map 'wasi:clocks/*=../clocks-impl.js#*'
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
