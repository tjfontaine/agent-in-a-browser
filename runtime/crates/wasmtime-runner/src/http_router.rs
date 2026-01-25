//! HTTP router for MCP requests
//!
//! Intercepts localhost:3000/mcp requests and routes them to the MCP component's
//! wasi:http/incoming-handler.

use anyhow::Result;
use wasmtime::component::Linker;

use crate::HostState;

/// Add HTTP routing to the linker
///
/// For now, this is a placeholder. The actual implementation will:
/// 1. Intercept outgoing HTTP requests to localhost:3000/mcp
/// 2. Convert them to incoming requests for the MCP component
/// 3. Call the MCP component's wasi:http/incoming-handler
/// 4. Return the response to the TUI
pub fn add_to_linker(_linker: &mut Linker<HostState>) -> Result<()> {
    // The wasmtime-wasi-http already provides wasi:http/outgoing-handler
    // We need to wrap it to intercept localhost/mcp requests
    //
    // For initial implementation, we rely on wasmtime-wasi-http's default
    // behavior which will make real HTTP requests. The TUI can be configured
    // to point to an external MCP server.
    //
    // TODO: Implement request interception to route to local MCP component

    Ok(())
}
