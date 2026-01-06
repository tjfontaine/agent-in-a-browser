//! MCP Transport Trait
//!
//! Abstracts MCP operations so they can be implemented differently by each
//! WASM component. This allows the same agent logic to work with different
//! MCP backends (local sandbox, remote servers).

use serde_json::Value;

/// Tool definition from MCP
#[derive(Clone, Debug)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Error type for MCP operations
#[derive(Debug, Clone)]
pub enum McpError {
    /// Transport error (network, IPC, etc.)
    TransportError(String),
    /// Protocol error (invalid JSON-RPC, etc.)
    ProtocolError(String),
    /// Tool not found
    ToolNotFound(String),
    /// Tool execution error
    ToolExecutionError(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::TransportError(e) => write!(f, "Transport error: {}", e),
            McpError::ProtocolError(e) => write!(f, "Protocol error: {}", e),
            McpError::ToolNotFound(name) => write!(f, "Tool not found: {}", name),
            McpError::ToolExecutionError(e) => write!(f, "Tool execution error: {}", e),
        }
    }
}

impl std::error::Error for McpError {}

/// MCP transport trait for tool execution
///
/// This trait abstracts over the MCP client implementation, allowing the same
/// agent logic to work with different MCP backends:
/// - Local sandbox (OPFS filesystem, browser APIs)
/// - Remote MCP servers (HTTP/SSE)
/// - Mock implementations for testing
pub trait McpTransport: Send + Sync {
    /// List available tools from this MCP source
    fn list_tools(&self) -> Result<Vec<ToolDefinition>, McpError>;

    /// Call a tool with the given arguments
    fn call_tool(&self, name: &str, arguments: Value) -> Result<String, McpError>;
}
