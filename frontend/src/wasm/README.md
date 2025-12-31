# WASM Bridge Layer

This directory contains the browser-side infrastructure that connects the WASM MCP server to browser APIs.

## Directory Structure

```text
wasm/
├── host-shims/           # WASI interface implementations
│   ├── opfs-filesystem-impl.ts   # wasi:filesystem/* (SyncAccessHandle + OPFS)
│   ├── wasi-http-impl.ts         # wasi:http/outgoing-handler
│   ├── clocks-impl.js            # wasi:clocks/* (custom Pollable)
│   ├── streams.ts                # InputStream, OutputStream, ReadyPollable
│   ├── directory-tree.ts         # OPFS structure and symlink cache
│   ├── opfs-sync-bridge.ts       # Synchronous file I/O via Atomics
│   ├── opfs-async-helper.ts      # Helper worker for async OPFS
│   └── terminal-info-impl.js     # Terminal size WIT interface
│
├── lazy-loading/         # Module loading infrastructure
│   ├── async-mode.ts             # JSPI detection + MCP server loading
│   ├── lazy-modules.ts           # On-demand module loading (tsx, sqlite, git)
│   └── module-loader-impl.ts     # Module instantiation + LazyProcess
│
├── tui/                  # Terminal UI integration
│   ├── tui-loader.ts             # ghostty-web ↔ Ratatui WASM bridge
│   └── ghostty-cli-shim.ts       # Terminal stdin/stdout to WASI I/O
│
├── git/                  # Git integration
│   ├── git-module.ts             # isomorphic-git wrapper
│   ├── opfs-git-adapter.ts       # OPFS → isomorphic-git fs adapter
│   └── symlink-store.ts          # IndexedDB symlink persistence
│
└── (generated)/          # jco-transpiled WASM modules (do not edit)
    ├── mcp-server-jspi/          # Chrome (JSPI mode)
    ├── mcp-server-sync/          # Safari/Firefox (sync mode)
    ├── tsx-engine/               # TypeScript execution
    ├── sqlite-module/            # SQLite database
    ├── ratatui-demo/             # Demo TUI
    └── web-agent-tui/            # Main Ratatui TUI
```

## Architecture

```text
main-tui.ts → tui-loader.ts → ghostty-web terminal
                    ↓
            web-agent-tui.wasm (Ratatui TUI)
                    ↓
            shell:unix/command → ts-runtime-mcp.wasm
                    ↓
            ┌───────┴───────┐
            ▼               ▼
    opfs-filesystem   wasi-http-impl
         ↓                   ↓
        OPFS           sandbox worker
```

## Key Components

| Component | Purpose |
|-----------|---------|
| **host-shims/** | Implement WASI interfaces for browser environment |
| **lazy-loading/** | JSPI detection, dynamic module loading |
| **tui/** | Connect ghostty terminal to Ratatui WASM |
| **git/** | Git operations via isomorphic-git + OPFS |

## Build Process

1. **Rust**: `cargo component build --release --target wasm32-wasip2`
2. **jco**: `npm run transpile:all` (generates `--map` bindings to host-shims)
3. **Vite**: bundles for browser

## jco Mapping

The transpile scripts map WASI interfaces to host-shims:

```text
--map 'wasi:filesystem/*=../host-shims/opfs-filesystem-impl.js#*'
--map 'wasi:http/outgoing-handler=../host-shims/wasi-http-impl.js#outgoingHandler'
--map 'wasi:clocks/*=../host-shims/clocks-impl.js#*'
--map 'mcp:module-loader/loader=../lazy-loading/module-loader-impl.js'
```

## Related Packages

This code has been extracted into standalone npm packages under `packages/`:

| Package | Purpose |
|---------|---------|
| `@tjfontaine/wasm-loader` | Core module registration system |
| `@tjfontaine/wasm-modules` | Aggregator for all module metadata |
| `@tjfontaine/wasm-tsx` | TSX engine metadata |
| `@tjfontaine/wasm-sqlite` | SQLite module metadata |
| `@tjfontaine/wasm-ratatui` | Ratatui demo metadata |
| `@tjfontaine/wasm-vim` | Vim editor metadata |
| `@tjfontaine/wasi-shims` | Shared WASI shims (clocks, streams, terminal) |
| `@tjfontaine/opfs-wasi-fs` | OPFS filesystem implementation |
| `@tjfontaine/wasi-http-handler` | HTTP handler implementation |
| `@tjfontaine/mcp-wasm-server` | MCP runtime with lazy loading |
| `@tjfontaine/browser-mcp-runtime` | Meta-package for one-line setup |
