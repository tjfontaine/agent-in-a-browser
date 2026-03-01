# Edge Agent

A privacy-first AI agent that runs entirely in the browser (WASM) or on-device (iOS), with no cloud dependency for code execution. Users interact via a terminal UI or conversational iOS workspace. The agent can read/write files, execute shell commands, run TypeScript, query SQLite, and call external MCP servers — all sandboxed.

## Project Goals

- **Zero-setup, privacy-first**: All tool execution happens client-side in WASM or on-device. API keys go directly to LLM providers, never through our servers.
- **Multi-platform**: Browser (WASM), iOS/macOS (Swift + WASM), and native CLI (wasmtime-runner) share the same Rust core.
- **Provider-agnostic**: Works with Anthropic Claude, OpenAI, Google Gemini, OpenRouter, and any OpenAI-compatible endpoint.
- **MCP-native**: Tools are exposed via Model Context Protocol (JSON-RPC 2.0). External MCP servers can be connected for extended capabilities.
- **Real shell, real filesystem**: 50+ POSIX commands, pipes, redirects, control flow — not a toy sandbox.

## Repository Layout

```
runtime/                      Rust workspace — compiles to WASM components
  src/                        MCP HTTP server + shell + file tools (lib.rs)
  src/shell/                  50+ shell commands (ls, grep, sed, awk, jq, sqlite3, tsx…)
  runtime-macros/             #[mcp_tool] and #[shell_command] proc macros
  crates/
    core/ (agent-bridge)      LLM integration via rig-core (models, conversation, MCP transport)
    mcp-server-core/          MCP protocol types, JSON-RPC handler
    tsx-engine/               TypeScript runtime (SWC transpiler + QuickJS interpreter)
    sqlite-module/            SQLite via Turso/LibSQL
    edtui-module/             Vim-like text editor (ropey + syntect)
    web-agent-tui/            Ratatui terminal UI (agent mode + shell mode)
    web-headless-agent/       Headless agent for JS embedding
    wasmtime-runner/          Native binary runner for development/testing
  wit/                        WIT interface definitions (world.wit)

packages/                     npm packages (pnpm workspace)
  web-agent-core/             Public JS API — WebAgent class wrapping WASM
  browser-mcp-runtime/        MCP runtime for browser
  opfs-wasi-fs/               OPFS-backed WASI filesystem
  wasi-shims/                 WASI Preview 2 browser shims
  wasm-loader/                WASM module loading
  wasm-ratatui/               Ratatui ↔ xterm.js bridge
  wasm-tsx/                   TypeScript engine bindings
  wasm-sqlite/                SQLite bindings
  wasm-vim/                   Vim editor bindings

frontend/                     React + Vite web UI
  src/agent/                  Agent integration (sandbox worker, streaming)
  e2e/                        Playwright E2E tests

ios-edge-agent/               iOS/macOS app (SwiftUI, Swift 6.2)
  EdgeAgent/
    App/                      @main entry point
    Bridge/                   WASM ↔ Swift bridge, MCP server, agent events
    Models/                   ConfigManager (provider, model, API key)
    Services/                 EdgeAgentSession, MCPToolBridge, AgentInstructions
    Views/                    SuperAppView (workspace), LauncherView, AppCanvasView,
                              ComponentLibrary (SDUI), ConversationTimeline, SettingsView
    Utilities/                OSLog wrappers
  LocalPackages/
    OpenFoundationModels/     Apple Foundation Models β SDK (has its own CLAUDE.md)
  WASIP2Harness/              WASM runtime for iOS
  WASIShims/                  WASI syscall shims
  MCPServerKit/               MCP server Swift package
  WasmBindgen/                Rust ↔ Swift bindings

worker/                       Cloudflare Workers (COOP/COEP headers, static assets)
tools/                        MCP bridge utilities
website/                      Documentation site
```

## Architecture

### Data Flow (Browser)

```
Browser UI (React/xterm.js)
  → SharedWorker (sandbox)
    → WASM Components (Rust → wasm32-wasip2)
      ├─ web-agent-tui        Ratatui terminal with agent + shell modes
      │  └─ agent-bridge      rig-core multi-turn loop with tool calling
      ├─ ts-runtime-mcp       MCP HTTP server + shell + file tools
      ├─ tsx-engine            TypeScript execution (SWC + QuickJS)
      ├─ sqlite-module         SQLite database (lazy-loaded)
      └─ edtui-module          Vim editor (lazy-loaded)
```

### Data Flow (iOS)

```
SwiftUI (SuperAppView)
  → EdgeAgentSession (ObservableObject)
    → LanguageModelSession (OpenFoundationModels)
      → LLM Provider (OpenAI-compatible API)
      → MCPToolBridge
        ├─ DynamicMCPTool (local: save_script, ask_user, list_scripts…)
        │  └─ MCPServer (HTTP, port 9292)
        └─ RemoteMCPTool (external MCP servers)
      → AgentEvent stream → UI updates
```

### Key Abstractions

- **MCP Transport** (`runtime/crates/core/src/mcp_transport.rs`): Trait abstracting tool discovery/execution across local sandbox, iOS bridge, and remote servers.
- **ConversationHistory** (`runtime/crates/core/src/conversation.rs`): Immutable transcript with roles (User, Assistant, System, ToolCall, ToolResult) driving all LLM interactions.
- **AgentEvent** (`ios-edge-agent/EdgeAgent/Bridge/AgentEvent.swift`): Enum bus for streaming UI updates (chunks, tool calls, results, ask_user prompts, progress).
- **ComponentLibrary** (`ios-edge-agent/EdgeAgent/Views/ComponentLibrary.swift`): SDUI renderer — agent generates JSON component trees, Swift renders them live.

## Build & Development

### Prerequisites

- Rust toolchain with `wasm32-wasip2` target
- Node.js + pnpm 9.x
- For iOS: Xcode with Swift 6.2+, iOS 18+ SDK

### Common Commands

```sh
# Rust — build all WASM components
cargo build --target wasm32-wasip2 --release

# Rust — run tests (native)
cargo test

# Rust — format check
cargo fmt --check

# npm — install dependencies
pnpm install

# npm — build all packages + frontend
pnpm build

# npm — dev server (frontend + WASM hot reload)
pnpm dev

# npm — run tests
pnpm test

# E2E — Playwright tests
pnpm test:e2e

# iOS — build via Xcode or:
xcodebuild -project ios-edge-agent/EdgeAgent.xcodeproj -scheme EdgeAgent
```

### CI Pipeline (`.github/workflows/build.yml`)

1. `rust-quality` — `cargo fmt --check` + warning-free build
2. `rust-component` — Build all WASM components
3. `frontend` — Build React app
4. `test` — Rust tests + frontend tests
5. `e2e-test` — Playwright (Chromium)

Deployment: Cloudflare Workers (`agent.edge-agent.dev`) via `deploy-pages.yml`.

## Conventions

### Rust

- **Edition 2021**, release profile optimized for size (`opt-level = "z"`, LTO)
- Tools defined with `#[mcp_tool(description = "…")]` macro, routed by `#[mcp_tool_router]`
- Shell commands defined with `#[shell_command(name, usage, description)]`, routed by `#[shell_commands]`
- All WASM components export WIT interfaces (`runtime/wit/`)
- `wit-bindgen 0.52` / `wit-bindgen-rt 0.44` for bindings
- `rig-core` (custom fork) for LLM agent loop — supports streaming, multi-turn tool calling
- Keep builds warning-free — CI enforces this

### TypeScript / npm

- pnpm workspaces with Turbo for orchestration
- Packages under `packages/`, frontend under `frontend/`
- Vite for dev/build, Playwright for E2E

### Swift / iOS

- **Swift 6.2** with strict concurrency checking
- `@MainActor` for all UI-touching code (ConfigManager, EdgeAgentSession, views)
- OpenFoundationModels local package has its own CLAUDE.md with Apple API compliance rules
- SDUI pattern: agent generates component JSON → ComponentLibrary renders → TemplateRenderer resolves `{{bindings}}`
- SQLite persistence via GRDB (AppBundleRepository)
- Agent events delivered via `@Published` properties on EdgeAgentSession

### General

- Avoid over-engineering — make only requested changes
- Read code before modifying it
- Delete unused code completely, no backward-compat shims
- Keep responses/comments concise
- Parallel tool calls when independent, sequential when dependent

## Key Files for Common Tasks

| Task | Start here |
|------|-----------|
| Add/modify MCP tools | `runtime/src/lib.rs` (tool functions + `#[mcp_tool]`) |
| Add shell commands | `runtime/src/shell/` (per-category modules) |
| Change agent behavior | `runtime/crates/core/src/rig_agent.rs`, `conversation.rs` |
| LLM provider config | `runtime/crates/core/src/models.rs` |
| MCP protocol changes | `runtime/crates/mcp-server-core/src/protocol.rs` |
| TUI layout/UX | `runtime/crates/web-agent-tui/src/ui/` |
| System prompt | `runtime/crates/web-agent-tui/src/bridge/SYSTEM_PROMPT.md` |
| Frontend UI | `frontend/src/` |
| iOS agent session | `ios-edge-agent/EdgeAgent/Services/EdgeAgentSession.swift` |
| iOS tool bridge | `ios-edge-agent/EdgeAgent/Services/MCPToolBridge.swift` |
| iOS views/canvas | `ios-edge-agent/EdgeAgent/Views/SuperAppView.swift` |
| iOS SDUI components | `ios-edge-agent/EdgeAgent/Views/ComponentLibrary.swift` |
| iOS system prompt | `ios-edge-agent/EdgeAgent/Services/AgentInstructions.swift` |
| WASM/WIT interfaces | `runtime/wit/world.wit` |
| Proc macros | `runtime/runtime-macros/src/lib.rs` |
| Sandbox filesystem | `ios-edge-agent/WASIP2Harness/Sources/WASIP2Harness/SandboxFilesystem.swift` |
