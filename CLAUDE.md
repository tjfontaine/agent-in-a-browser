# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is This

Edge Agent — a privacy-first AI agent that runs entirely in the browser (WASM) or on-device (iOS). No cloud dependency for code execution. Users interact via a terminal UI or conversational iOS workspace. The agent can read/write files, execute shell commands, run TypeScript, query SQLite, and call external MCP servers — all sandboxed client-side.

## Build System: Moon

This monorepo uses [Moon](https://moonrepo.dev/) as its task orchestrator. Moon manages the full dependency graph across Rust, TypeScript, and frontend builds. Configuration lives in:

- `.moon/workspace.yml` — project discovery (`packages/*`, `frontend`, `worker`, `runtime`)
- `.moon/toolchains.yml` — Node 22.22.0, pnpm 9.15.4, Rust with `wasm32-wasip2`, TypeScript with `syncProjectReferences`
- `.moon/tasks/node.yml` — default `build` task (`tsc`) inherited by all Node projects
- Per-project `moon.yml` — project-specific tasks and dependency overrides

### Build Pipeline

Moon resolves this dependency graph automatically:

```
wit-deps → build-wasm → transpile/transpile-sync → build (per package) → frontend:build → frontend:copy-externals
                                                                                        → frontend:test
                                                                                        → frontend:test-e2e
```

The WASM → JS pipeline: Rust compiles to `wasm32-wasip2` components → `scripts/transpile.mjs` uses JCO to transpile each `.wasm` into JS/ESM modules → packages consume transpiled output → frontend bundles everything with Vite.

### Common Commands

```sh
pnpm install                          # Install dependencies

# Full builds
pnpm build                            # moon run :build :transpile :transpile-sync
pnpm build:wasm                       # moon run runtime:build-wasm
pnpm build:frontend                   # moon run frontend:build frontend:copy-externals

# Development
pnpm dev                              # Concurrent WASM watch + Vite dev server

# Testing
pnpm test                             # moon run :test (Rust + frontend unit tests)
pnpm test:e2e                         # moon run frontend:test-e2e (Playwright, chromium)

# Targeted Moon tasks
moon run runtime:build-wasm            # Build all WASM components
moon run runtime:fmt-check             # cargo fmt --all --check
moon run runtime:check                 # cargo check --workspace (warning-free, excludes wasmtime-runner)
moon run runtime:check-native          # cargo check -p wasmtime-runner (depends on build-wasm)
moon run runtime:test                  # cargo test --features sqlite
moon run frontend:build                # Build frontend (auto-resolves all upstream deps)
moon run frontend:test                 # vitest run
moon run frontend:test-e2e             # Playwright E2E tests
```

### Validating Changes (Reproduce CI Locally)

The CI job (`.github/workflows/build.yml`) runs this single Moon invocation:

```sh
moon run \
  runtime:fmt-check \
  runtime:check \
  runtime:build-wasm \
  runtime:verify-wasm \
  runtime:check-native \
  runtime:test \
  frontend:build \
  frontend:copy-externals \
  frontend:test
```

Then separately: `moon run frontend:test-e2e` (requires Playwright browsers installed).

**Pre-push hooks** (lefthook): `runtime:fmt-check` and `runtime:check` run automatically before `git push`. Fix with `cargo fmt --all` if formatting fails.

### Moon Gotchas

- Moon does NOT auto-infer deps from `package.json` — each `moon.yml` must declare explicit `deps` for inter-package ordering
- The default `build` task (from `.moon/tasks/node.yml`) is `tsc` — Rust projects exclude it via `workspace.inheritedTasks.exclude`
- `build-wasm` needs explicit `-p` flags for each crate; omitting them only builds the workspace root
- `script:` tasks (not `command:`) are required for shell operators like `&&`
- `cargo component build` regenerates `bindings.rs` — run `cargo fmt` afterward (already chained in `build-wasm`)

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

### WASM ↔ JS Bridge

Rust crates compile to WASM component model (WIT interfaces in `runtime/wit/`). JCO transpiles each `.wasm` to JS/ESM with `--map` flags routing WASI imports to browser shims (`packages/wasi-shims/`). Two modes per module:
- **JSPI (async)**: Default, uses WebAssembly JS Promise Integration
- **Sync**: Safari fallback via `--sync` flag, generates `*-sync` variants

Every new shim added to `scripts/transpile.mjs` must also be added to `frontend/vite.config.ts` paths (both worker and build sections).

### Key Abstractions

- **MCP Transport** (`runtime/crates/core/src/mcp_transport.rs`): Trait abstracting tool discovery/execution across local sandbox, iOS bridge, and remote servers.
- **ConversationHistory** (`runtime/crates/core/src/conversation.rs`): Immutable transcript with roles (User, Assistant, System, ToolCall, ToolResult) driving all LLM interactions.
- **AgentEvent** (`ios-edge-agent/EdgeAgent/Bridge/AgentEvent.swift`): Enum bus for streaming UI updates (chunks, tool calls, results, ask_user prompts, progress).
- **ComponentLibrary** (`ios-edge-agent/EdgeAgent/Views/ComponentLibrary.swift`): SDUI renderer — agent generates JSON component trees, Swift renders them live.

## Conventions

### Rust

- **Edition 2021**, release profile optimized for size (`opt-level = "z"`, LTO)
- Tools defined with `#[mcp_tool(description = "…")]` macro, routed by `#[mcp_tool_router]`
- Shell commands defined with `#[shell_command(name, usage, description)]`, routed by `#[shell_commands]`
- All WASM components export WIT interfaces (`runtime/wit/`)
- `wit-bindgen 0.53` / `wit-bindgen-rt 0.44` for bindings
- `rig-core` (custom fork) for LLM agent loop — supports streaming, multi-turn tool calling
- Keep builds warning-free — CI enforces this

### TypeScript / npm

- pnpm workspaces — all packages under `packages/`, frontend under `frontend/`
- Strict TypeScript (`strict: true`) in all tsconfigs, `composite: true` for Moon project reference syncing
- Vite for dev/build, Playwright for E2E

### Swift / iOS

- **Swift 6.2** with strict concurrency checking
- `@MainActor` for all UI-touching code (ConfigManager, EdgeAgentSession, views)
- OpenFoundationModels local package has its own CLAUDE.md with Apple API compliance rules
- SDUI pattern: agent generates component JSON → ComponentLibrary renders → TemplateRenderer resolves `{{bindings}}`
- SQLite persistence via GRDB (AppBundleRepository)

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
| WASM→JS transpile config | `scripts/transpile.mjs` |
| Vite shim paths | `frontend/vite.config.ts` |
| Moon workspace config | `.moon/workspace.yml`, `.moon/toolchains.yml` |
| Per-project build tasks | `<project>/moon.yml` |
| CI pipeline | `.github/workflows/build.yml` |
| Pre-push hooks | `lefthook.yml` |
