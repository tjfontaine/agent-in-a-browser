//! Minimal MCP (Model Context Protocol) server implementation.
//!
//! This module re-exports types from mcp-server-core and provides
//! the application-specific tool handling.

// Re-export all types from mcp-server-core
pub use mcp_server_core::*;

// Keep run_stdio_server here since it depends on std::io
use std::io::{self, BufRead, Write};

/// Run an MCP server on stdio
pub fn run_stdio_server<S: McpServer>(mut server: S) -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                let response = JsonRpcResponse::error(None, -32700, format!("Parse error: {}", e));
                writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
                stdout.flush()?;
                continue;
            }
        };

        let response = handle_request(&mut server, request);
        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }

    Ok(())
}
