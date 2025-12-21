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
   mcp-client.ts ──────┼──►│  - mcp:ts-runtime/browser-fs         │  │
          │            │   │  - mcp:ts-runtime/browser-http       │  │
          │            │   │  - wasi:http/*                       │  │
          │            │   │                                       │  │
          │            │   │  Exports:                            │  │
          │            │   │  - wasi:http/incoming-handler        │  │
          │            │   └─────────┬───────────────┬────────────┘  │
          │            │             │               │                │
          │            │             ▼               ▼                │
          │            │   ┌─────────────┐  ┌──────────────────┐     │
          │            │   │browser-fs   │  │browser-http      │     │
          │            │   │-impl.ts     │  │-impl.ts          │     │
          │            │   │             │  │                  │     │
          │            │   │ In-memory   │  │ Sync XHR for     │     │
          │            │   │ + OPFS      │  │ HTTP requests    │     │
          │            │   └─────────────┘  └──────────────────┘     │
          │            │                                              │
          │            │   ┌────────────────────────────────────┐    │
          │            │   │ wasi-http-impl.ts                  │    │
          │            │   │ Async fetch() for outgoing HTTP    │    │
          │            │   └────────────────────────────────────┘    │
          └────────────┴──────────────────────────────────────────────┘
```

## Directory Contents

### Generated Code (do not edit manually)

| Directory | Description |
|-----------|-------------|
| `mcp-server/` | jco-transpiled WASM component (ES modules) |

### Host Bridge Implementations

| File | WIT Interface | Purpose |
|------|---------------|---------|
| `browser-fs-impl.ts` | `mcp:ts-runtime/browser-fs` | Sync filesystem via in-memory cache + OPFS persistence |
| `browser-http-impl.ts` | `mcp:ts-runtime/browser-http` | Sync HTTP via XMLHttpRequest |
| `wasi-http-impl.ts` | `wasi:http/*` | Async HTTP via fetch() |

## How It Works

### 1. MCP Request Flow

```text
Agent → MCP Client → postMessage → Worker → WASM Component → Tool Result
```

The AI agent (Vercel AI SDK) sends MCP JSON-RPC requests. The `mcp-client.ts` in the main thread forwards these via `postMessage` to the Web Worker. The worker invokes the WASM component's HTTP handler, which processes the request and returns results.

### 2. File System Bridge

The WASM component needs synchronous file operations, but browser OPFS is async. We solve this with a **hybrid architecture**:

1. **In-memory cache** - All file state kept in memory (instant sync reads)
2. **Background persistence** - Writes go to OPFS asynchronously (fire-and-forget)
3. **Session isolation** - Sandbox starts empty, no startup sync needed

```typescript
// browser-fs-impl.ts exports these sync functions:
export const browserFs = {
    readFile(path: string): string,   // Returns JSON: {ok, content} or {ok: false, error}
    writeFile(path: string, content: string): string,
    listDir(path: string): string,
    grep(pattern: string, path: string): string,
};
```

### 3. HTTP Bridge

Two different HTTP implementations:

| Implementation | When Used | Why |
|----------------|-----------|-----|
| `browser-http-impl.ts` | Internal WASM calls | Sync XMLHttpRequest for blocking calls |
| `wasi-http-impl.ts` | Standard WASI HTTP | Async fetch() for wasi:http compatibility |

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
   --map 'mcp:ts-runtime/browser-fs=../browser-fs-impl.js#browserFs'
   --map 'mcp:ts-runtime/browser-http=../browser-http-impl.js#browserHttp'
   --map 'wasi:http/types=../wasi-http-impl.js'
   ...
   ```

3. **Vite bundles** everything for the browser

## Updating Host Bridges

When modifying `browser-fs-impl.ts` or `browser-http-impl.ts`:

1. **Match the WIT interface** - Functions must match signatures in `runtime/wit/world.wit`
2. **Return JSON strings** - All functions return `string` containing JSON
3. **Handle errors** - Return `{ok: false, error: "message"}` on failure
4. **Keep it synchronous** - The WASM component expects sync responses

Example for adding a new `browser-fs` function:

```typescript
// 1. Add to runtime/wit/world.wit:
//    new-function: func(arg: string) -> string;

// 2. Implement in browser-fs-impl.ts:
function newFunction(arg: string): string {
    try {
        const result = /* ... */;
        return JSON.stringify({ ok: true, data: result });
    } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
    }
}

// 3. Export in browserFs object:
export const browserFs = {
    // ...existing...
    newFunction,
};

// 4. Rebuild: cargo component build && npm run transpile:component
```

## Related Documentation

- [Runtime README](../../../runtime/README.md) - Rust MCP server
- [WIT Interfaces](../../../runtime/wit/world.wit) - Interface definitions
