//! Library target for wasmtime-runner.
//!
//! Exposes the MCP component infrastructure for integration testing.
//! The binary (`wasm-tui`) is built from `main.rs` and uses these modules
//! alongside its own TUI-specific modules.

pub mod bindings;
pub mod mcp_stdio;
pub mod module_loader;
