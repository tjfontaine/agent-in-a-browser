---
description: How to build the full project (Rust WASM + Frontend)
---

# Full Build Workflow

This workflow builds the Rust WASM component, runs tests, and transpiles for the frontend.

## Prerequisites

- Rust toolchain with `wasm32-wasip2` target
- `cargo-component` installed
- Node.js and npm

## Steps

### 1. Build Rust WASM Component (Release)

// turbo

```bash
cd runtime && cargo component build --release --target wasm32-wasip2
```

This compiles the Rust MCP server to a WASM component at:
`target/wasm32-wasip2/release/ts-runtime-mcp.wasm`

### 2. Run Frontend Tests

// turbo

```bash
cd frontend && npm test
```

Runs Vitest with 74 tests covering command-parser, TUI, types, constants, etc.

### 3. Transpile WASM to JavaScript

// turbo

```bash
cd frontend && npm run transpile:component
```

This uses `jco` to transpile the WASM component to JavaScript modules at:
`frontend/src/wasm/mcp-server/`

### 4. (Optional) Run Frontend Dev Server

```bash
cd frontend && npm run dev
```

### 5. (Optional) Full Production Build

```bash
npm run build
```

This runs steps 1, 3, plus TypeScript compilation and Vite production build.

## Quick One-Liner

// turbo

```bash
npm run build:wasm && cd frontend && npm test && npm run transpile:component
```
