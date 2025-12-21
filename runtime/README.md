# TypeScript Runtime MCP Server

A WebAssembly-based MCP (Model Context Protocol) server that provides TypeScript execution and file system tools for browser-based AI agents.

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                          Browser Environment                            │
│                                                                         │
│  ┌──────────────┐     ┌─────────────────────────────────────────────┐   │
│  │ Main Thread  │     │              Web Worker                     │   │
│  │              │     │                                             │   │
│  │  AI Agent    │     │  ┌────────────────────────────────────────┐ │   │
│  │  (Vercel AI) ├────►│  │     WASM MCP Server (this crate)       │ │   │
│  │              │     │  │                                        │ │   │
│  │  MCP Client  │     │  │  ┌─────────────┐  ┌─────────────────┐  │ │   │
│  └──────────────┘     │  │  │ QuickJS-NG  │  │ SWC Transpiler  │  │ │   │
│                       │  │  │ (execution) │  │ (TS → JS)       │  │ │   │
│                       │  │  └─────────────┘  └─────────────────┘  │ │   │
│                       │  │                                        │ │   │
│                       │  │   Implements wasi:http/incoming-handler│ │   │
│                       │  └──────────────────────┬─────────────────┘ │   │
│                       │                         │                   │   │
│                       │  ┌──────────────────────▼─────────────────┐ │   │
│                       │  │         Host Bridges (TypeScript)      │ │   │
│                       │  │                                        │ │   │
│                       │  │  browser-fs-impl.ts → OPFS             │ │   │
│                       │  │  browser-http-impl.ts → sync XHR       │ │   │
│                       │  └────────────────────────────────────────┘ │   │
│                       └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Concepts

### WASI Component Model

This crate builds as a **WASI Preview 2 Component** targeting `wasm32-wasip2`. The component:

- **Exports**: `wasi:http/incoming-handler@0.2.4` (receives MCP requests via HTTP)
- **Imports**: Standard WASI interfaces (bridged to browser APIs via TypeScript shims)

### Browser WASI Bridges

Standard WASI interfaces are bridged to browser APIs via TypeScript shims in `frontend/src/wasm/`:

| WASI Interface | Browser Bridge | Implementation |
|----------------|----------------|----------------|
| `wasi:filesystem/*` | `opfs-filesystem-impl.ts` | OPFS via SyncAccessHandle |
| `wasi:http/outgoing-handler` | `wasi-http-impl.ts` | Sync XMLHttpRequest |
| `wasi:clocks/*` | `clocks-impl.js` | Custom Pollable with busy-wait |

### MCP Tools Provided

| Tool | Description |
|------|-------------|
| `run_typescript` | Execute TypeScript/JavaScript code |
| `read_file` | Read file content from virtual filesystem |
| `write_file` | Write content to virtual filesystem |
| `list` | List directory contents |
| `grep` | Search for patterns in files |
| `shell_eval` | Evaluate shell commands (cd, ls, cat, echo, etc.) |

## Project Structure

```text
runtime/
├── Cargo.toml              # Package manifest with WASI component metadata
├── README.md               # This file
│
├── src/
│   ├── main.rs             # HTTP handler + MCP tool dispatch
│   ├── mcp_server.rs       # JSON-RPC types and McpServer trait
│   ├── bindings.rs         # Generated WIT bindings (cargo-component)
│   │
│   ├── host_bindings.rs    # Console, path polyfills for QuickJS
│   ├── loader.rs           # Module loader (CDN + local files)
│   ├── resolver.rs         # Import specifier resolution
│   ├── transpiler.rs       # SWC TypeScript → JavaScript
│   ├── http_client.rs      # Outgoing HTTP via WASI HTTP
│   └── shell/              # Shell command implementation
│       ├── mod.rs          # Shell infrastructure
│       ├── commands/       # Built-in commands (ls, cat, cd, etc.)
│       └── pipeline.rs     # Command pipeline execution
│
├── wit/
│   ├── world.wit           # Component world definition
│   ├── handler.wit         # HTTP incoming-handler interface
│   ├── deps/               # WASI interface dependencies
│   └── deps.toml           # wit-deps configuration
│
└── runtime-macros/         # Proc macros for MCP tool definitions
    └── ...
```

## Building

### Prerequisites

```bash
# Install required tools
rustup target add wasm32-wasip2
cargo install cargo-component wit-deps
```

### Build Commands

```bash
# From workspace root
cargo component build --release --target wasm32-wasip2 --manifest-path runtime/Cargo.toml

# Output: target/wasm32-wasip2/release/ts-runtime-mcp.wasm
```

### Update WIT Dependencies

```bash
cd runtime
wit-deps update
```

## Frontend Integration

After building the WASM component, it must be transpiled for browser use:

```bash
cd frontend
npm run transpile:component
```

This runs `jco transpile` with mappings that connect WASI interfaces to browser shims:

- `wasi:*` → `@bytecodealliance/preview2-shim`
- `mcp:ts-runtime/browser-fs` → `browser-fs-impl.ts`
- `mcp:ts-runtime/browser-http` → `browser-http-impl.ts`

**Output**: `frontend/src/wasm/mcp-server/` (ES modules)

## Testing

```bash
# Run all tests
cargo test -p ts-runtime-mcp

# Run with output
cargo test -p ts-runtime-mcp -- --nocapture
```

## Adding New MCP Tools

1. **Define the tool** in `main.rs` within the `TsRuntimeMcp` impl:

```rust
impl TsRuntimeMcp {
    fn my_new_tool(&self, arg: String) -> Result<String, String> {
        // Implementation
    }
}
```

1. **Register in `list_tools`** (in `main.rs`):

```rust
fn list_tools(&self) -> Vec<ToolDefinition> {
    vec![
        // ... existing tools ...
        ToolDefinition {
            name: "my_new_tool".to_string(),
            description: "Description for the agent".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "arg": { "type": "string", "description": "Argument" }
                },
                "required": ["arg"]
            }),
        },
    ]
}
```

1. **Dispatch in `call_tool`** (in `main.rs`):

```rust
fn call_tool(&mut self, name: &str, arguments: serde_json::Value) -> ToolResult {
    match name {
        // ... existing tools ...
        "my_new_tool" => {
            let arg = arguments["arg"].as_str().unwrap_or("").to_string();
            match self.my_new_tool(arg) {
                Ok(result) => ToolResult::text(result),
                Err(e) => ToolResult::error(e),
            }
        }
        _ => ToolResult::error(format!("Unknown tool: {}", name)),
    }
}
```

## Related Documentation

- [Frontend WASM Bridge](../frontend/src/wasm/README.md) - Host-side implementation
- [WIT Interfaces](./wit/world.wit) - Interface definitions
- [MCP Protocol](https://spec.modelcontextprotocol.io/) - Model Context Protocol spec
