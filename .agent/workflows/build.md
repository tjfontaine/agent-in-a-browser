---
description: How to build the full project (Rust WASM + Frontend)
---

# Full Build Workflow

This workflow builds the Rust WASM components, runs tests, and transpiles for the frontend. Build orchestration uses [Moon](https://moonrepo.dev/) — see `moon.yml` in each project directory for task definitions.

## Prerequisites

- Rust toolchain with `wasm32-wasip2` target (moon manages components and targets via `.moon/toolchains.yml`)
- Node.js 22+ and pnpm (`moon` is installed as a devDependency, cargo bins like `cargo-component`, `wit-deps-cli`, `wasm-tools` are managed by moon's Rust toolchain plugin)
- Playwright browsers: `cd frontend && npx playwright install chromium`

## Steps

### 0. Regenerate WIT Bindings (only when `.wit` files change)

Each WASM crate uses selective symlinks in its `wit/deps/` directory pointing to `runtime/wit/deps/<package>` for WASI dependencies. This avoids conflicts with the crate's own package namespace.

To regenerate bindings for a crate (e.g., tsx-engine):

```bash
cd runtime && wit-bindgen rust crates/tsx-engine/wit --world tsx-engine --runtime-path wit_bindgen_rt --generate-all --out-dir crates/tsx-engine/src/ && mv crates/tsx-engine/src/tsx_engine.rs crates/tsx-engine/src/bindings.rs
```

> **Note:** Only needed when WIT interfaces change. The generated `bindings.rs` is committed to the repo.

If a crate's `wit/deps/` symlinks are missing, create them:

```bash
mkdir -p crates/<crate>/wit/deps
for dep in io filesystem clocks http sockets random cli; do
  ln -sf ../../../../wit/deps/$dep crates/<crate>/wit/deps/$dep
done
```

### 1. Build Rust WASM Components (Release)

```bash
moon run runtime:build-wasm
```

This compiles all Rust WASM components:

- `target/wasm32-wasip2/release/ts_runtime_mcp.wasm` - MCP server, shell, and sandbox tools
- `target/wasm32-wasip2/release/tsx_engine.wasm` - TypeScript execution engine
- `target/wasm32-wasip2/release/sqlite_module.wasm` - SQLite database
- `target/wasm32-wasip2/release/edtui_module.wasm` - Vim editor
- `target/wasm32-wasip2/release/web_agent_tui.wasm` - TUI application, AI agent, OAuth client
- `target/wasm32-wasip2/release/web_headless_agent.wasm` - Headless agent

### 2. Run Rust Unit Tests

```bash
moon run runtime:test
```

Runs Rust unit tests including JS module tests (Buffer, path, fs, URL, etc.).

### 3. Transpile WASM to JavaScript + Build TypeScript Packages

Moon handles dependency ordering automatically — transpile tasks depend on `runtime:build-wasm` and package build tasks.

```bash
moon run :transpile :transpile-sync
```

This uses `jco` to transpile all WASM components to JavaScript modules:

- `frontend/src/wasm/mcp-server-jspi/` - Main shell and MCP tools (JSPI mode)
- `frontend/src/wasm/mcp-server-sync/` - Main shell and MCP tools (sync mode)
- `frontend/src/wasm/web-agent-tui/` - TUI application with AI agent
- `packages/wasm-tsx/wasm/` - TypeScript execution (lazy-loaded)
- `packages/wasm-sqlite/wasm/` - SQLite database (lazy-loaded)
- `packages/wasm-vim/wasm/` - Vim editor (lazy-loaded)
- `packages/wasm-ratatui/wasm/` - Interactive TUI demos (lazy-loaded)

### 4. Build Frontend

```bash
moon run frontend:build frontend:copy-externals
```

Runs `tsc` + `vite build`, then copies wasi-shims and wasm-loader bundles into `dist/`. This automatically runs all upstream transpile and package build tasks via moon dependency graph.

### 5. Run Frontend Unit Tests

```bash
moon run frontend:test
```

Runs Vitest tests covering command-parser, TUI, types, constants, etc.

### 6. Run E2E Browser Tests (Playwright)

```bash
moon run frontend:test-e2e
```

Runs Playwright tests in a real browser to verify WASM components work:

- Shell commands (echo, cat, ls, etc.)
- TypeScript execution
- Git operations
- Vim editor
- SQLite database

### 7. (Optional) Run Frontend Dev Server

```bash
moon run frontend:dev
```

### 8. (Optional) Rebuild wasi-shims (after changes)

```bash
moon run wasi-shims:build
```

## Quick One-Liners

### Full Build (WASM + Transpile + Frontend)

```bash
pnpm run build
# equivalent to: moon run :build :transpile :transpile-sync
```

### Build Frontend Only (moon resolves all upstream deps)

```bash
pnpm run build:frontend
# equivalent to: moon run frontend:build frontend:copy-externals
```

### Build WASM Only

```bash
pnpm run build:wasm
# equivalent to: moon run runtime:build-wasm
```

### Run All Tests

```bash
moon run :test
```

### Dev Server (WASM watch + Vite)

```bash
pnpm run dev
```

## iOS Build

### Build iOS WebRuntime Bundle

```bash
./ios-edge-agent/scripts/build-ios.sh
```

This builds the complete iOS WebRuntime bundle:

1. Builds Rust WASM components targeting `wasm32-wasip2`
2. Transpiles WASM to JavaScript using `jco` (sync mode for Safari — no JSPI)
3. Bundles files to `ios-edge-agent/EdgeAgent/Resources/WebRuntime/`

Output includes:

- `web-headless-agent-sync/` - Headless agent with WASI shims
- `mcp-server-sync/` - MCP server WASM component

### Clean iOS Build

```bash
./ios-edge-agent/scripts/build-ios.sh
```

Moon tracks inputs/outputs for cache invalidation automatically. If you need to force a rebuild after modifying Rust code, use `--force`:

```bash
moon run runtime:build-wasm runtime:transpile-ios --force
```

### Run in Xcode

1. Open `ios-edge-agent/EdgeAgent.xcodeproj` in Xcode
2. Set Development Team in Signing & Capabilities
3. Build and run (Cmd+R) on Simulator or device
