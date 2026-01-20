---
description: How to build the full project (Rust WASM + Frontend)
---

# Full Build Workflow

This workflow builds the Rust WASM components, runs tests, and transpiles for the frontend.

## Prerequisites

- Rust toolchain with `wasm32-wasip2` target
- `cargo-component` installed: `cargo install cargo-component`
- `wit-deps-cli` installed: `cargo install wit-deps-cli`
- Node.js 22+ and pnpm
- Playwright browsers: `cd frontend && npx playwright install chromium`

## Steps

### 1. Build Rust WASM Components (Release)

// turbo

```bash
cd runtime && cargo component build --release --target wasm32-wasip2
```

This compiles all Rust WASM components:

- `target/wasm32-wasip2/release/ts-runtime-mcp.wasm` - MCP server, shell, and sandbox tools
- `target/wasm32-wasip2/release/tsx_engine.wasm` - TypeScript execution engine
- `target/wasm32-wasip2/release/sqlite_module.wasm` - SQLite database
- `target/wasm32-wasip2/release/edtui_module.wasm` - Vim editor
- `target/wasm32-wasip2/release/web_agent_tui.wasm` - TUI application, AI agent, OAuth client
- `target/wasm32-wasip2/release/web_headless_agent.wasm` - Headless agent

### 2. Run Rust Unit Tests

// turbo

```bash
cd runtime && cargo test
```

Runs Rust unit tests including JS module tests (Buffer, path, fs, URL, etc.).

### 3. Build TypeScript Packages

// turbo

```bash
pnpm run build:packages
```

This builds all TypeScript packages including wasi-shims (both Node.js and browser bundles).

### 4. Transpile WASM to JavaScript

// turbo

```bash
cd frontend && pnpm run transpile:all
```

This uses `jco` to transpile all WASM components to JavaScript modules:

- `frontend/src/wasm/mcp-server-jspi/` - Main shell and MCP tools
- `frontend/src/wasm/web-agent-tui/` - TUI application with AI agent
- `packages/wasm-tsx/wasm/` - TypeScript execution (lazy-loaded)
- `packages/wasm-sqlite/wasm/` - SQLite database (lazy-loaded)
- `packages/wasm-vim/wasm/` - Vim editor (lazy-loaded)
- `packages/wasm-ratatui/wasm/` - Interactive TUI demos (lazy-loaded)

### 5. Run Frontend Unit Tests

// turbo

```bash
cd frontend && pnpm test
```

Runs Vitest tests covering command-parser, TUI, types, constants, etc.

### 6. Run E2E Browser Tests (Playwright)

// turbo

```bash
cd frontend && pnpm run test:e2e
```

Runs Playwright tests in a real browser to verify WASM components work:

- Shell commands (echo, cat, ls, etc.)
- TypeScript execution
- Git operations
- Vim editor
- SQLite database

### 7. (Optional) Run Frontend Dev Server

```bash
cd frontend && pnpm run dev
```

### 8. (Optional) Full Production Build

```bash
pnpm run build
```

This runs WASM build + transpile + TypeScript compilation + Vite production build.

## Quick One-Liners

### Full Build (WASM + Frontend)

// turbo

```bash
pnpm run build
```

### Build and Test All

// turbo

```bash
pnpm run build:wasm && cd runtime && cargo test && cd .. && pnpm run build:packages && cd frontend && pnpm run transpile:all && pnpm run test:all
```

### Quick Frontend Rebuild (after code changes)

// turbo

```bash
cd frontend && pnpm run build
```

### Rebuild wasi-shims (after changes)

// turbo

```bash
cd packages/wasi-shims && pnpm run build && pnpm run build:browser && cd ../../frontend && pnpm run copy:wasi-shims
```
