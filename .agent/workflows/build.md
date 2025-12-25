---
description: How to build the full project (Rust WASM + Frontend)
---

# Full Build Workflow

This workflow builds the Rust WASM component, runs tests, and transpiles for the frontend.

## Prerequisites

- Rust toolchain with `wasm32-wasip2` target
- `cargo-component` installed
- Node.js and npm
- Playwright browsers: `cd frontend && npx playwright install chromium`

## Steps

### 1. Build Rust WASM Component (Release)

// turbo

```bash
cd runtime && cargo component build --release --target wasm32-wasip2
```

This compiles the Rust MCP server to a WASM component at:
`target/wasm32-wasip2/release/ts-runtime-mcp.wasm`

### 2. Run Rust Unit Tests

// turbo

```bash
cd runtime && cargo test
```

Runs 422 Rust tests including JS module tests (Buffer, path, fs, URL, etc.).

### 3. Transpile WASM to JavaScript

// turbo

```bash
cd frontend && npm run transpile:component
```

This uses `jco` to transpile the WASM component to JavaScript modules at:
`frontend/src/wasm/mcp-server/`

### 4. Run Frontend Unit Tests

// turbo

```bash
cd frontend && npm test
```

Runs Vitest with 74 tests covering command-parser, TUI, types, constants, etc.

### 5. Run E2E Browser Tests (Playwright)

// turbo

```bash
cd frontend && npm run test:e2e
```

Runs Playwright tests in a real browser to verify WASM component works:

- fs module (sync and async)
- path module
- Buffer class
- URL/URLSearchParams
- TypeScript execution

### 6. (Optional) Run Frontend Dev Server

```bash
cd frontend && npm run dev
```

### 7. (Optional) Full Production Build

```bash
npm run build
```

This runs steps 1, 3, plus TypeScript compilation and Vite production build.

## Quick One-Liners

### Full Test Suite (Unit + E2E)

// turbo

```bash
npm run build:wasm && cd runtime && cargo test && cd ../frontend && npm run transpile:component && npm run test:all
```

### Unit Tests Only

// turbo

```bash
cd runtime && cargo test && cd ../frontend && npm test
```
