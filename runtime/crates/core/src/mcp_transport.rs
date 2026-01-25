//! MCP Transport Trait
//!
//! Abstracts MCP operations so they can be implemented differently by each
//! WASM component. This allows the same agent logic to work with different
//! MCP backends (local sandbox, remote servers).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Tool definition from MCP
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// MCP tool result content
#[derive(Debug, Clone, Deserialize)]
pub struct ToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
}

/// MCP tool result
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub content: Vec<ToolContent>,
    pub is_error: Option<bool>,
}

/// JSON-RPC response wrapper
#[derive(Debug, Deserialize)]
pub struct JsonRpcResponse<T> {
    #[allow(dead_code)]
    pub jsonrpc: String,
    #[allow(dead_code)]
    pub id: Option<Value>,
    pub result: Option<T>,
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
pub struct JsonRpcError {
    #[allow(dead_code)]
    pub code: i32,
    pub message: String,
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
    /// HTTP error
    HttpError(String),
    /// JSON error
    JsonError(String),
    /// RPC error
    RpcError(String),
    /// Not initialized
    NotInitialized,
    /// Lock error
    LockError,
    /// OAuth authentication required - contains server URL for OAuth flow
    OAuthRequired(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::TransportError(e) => write!(f, "Transport error: {}", e),
            McpError::ProtocolError(e) => write!(f, "Protocol error: {}", e),
            McpError::ToolNotFound(name) => write!(f, "Tool not found: {}", name),
            McpError::ToolExecutionError(e) => write!(f, "Tool execution error: {}", e),
            McpError::HttpError(e) => write!(f, "HTTP error: {}", e),
            McpError::JsonError(e) => write!(f, "JSON error: {}", e),
            McpError::RpcError(msg) => write!(f, "RPC error: {}", msg),
            McpError::NotInitialized => write!(f, "MCP client not initialized"),
            McpError::LockError => write!(f, "Failed to acquire lock"),
            McpError::OAuthRequired(url) => write!(f, "OAuth required for {}", url),
        }
    }
}

impl std::error::Error for McpError {}

// Make McpError Send + Sync
unsafe impl Send for McpError {}
unsafe impl Sync for McpError {}

impl From<serde_json::Error> for McpError {
    fn from(e: serde_json::Error) -> Self {
        McpError::JsonError(e.to_string())
    }
}

/// MCP transport trait for tool execution
///
/// This trait abstracts over the MCP client implementation, allowing the same
/// agent logic to work with different MCP backends:
/// - Local sandbox (OPFS filesystem, browser APIs)
/// - Remote MCP servers (HTTP/SSE)
/// - Mock implementations for testing
#[cfg_attr(test, mockall::automock)]
pub trait McpTransport: Send + Sync {
    /// List available tools from this MCP source
    fn list_tools(&self) -> Result<Vec<ToolDefinition>, McpError>;

    /// Call a tool with the given arguments
    fn call_tool(&self, name: &str, arguments: Value) -> Result<String, McpError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_list_tools_returns_configured_tools() {
        let mut mock = MockMcpTransport::new();
        mock.expect_list_tools().returning(|| {
            Ok(vec![ToolDefinition {
                name: "shell_eval".to_string(),
                description: "Execute shell command".to_string(),
                input_schema: serde_json::json!({}),
                title: None,
            }])
        });

        let tools = mock.list_tools().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "shell_eval");
    }

    #[test]
    fn mock_call_tool_returns_configured_result() {
        let mut mock = MockMcpTransport::new();
        mock.expect_call_tool()
            .withf(|name, _args| name == "shell_eval")
            .returning(|_name, _args| Ok("Hello, World!".to_string()));

        let result = mock
            .call_tool("shell_eval", serde_json::json!({"command": "echo hello"}))
            .unwrap();
        assert_eq!(result, "Hello, World!");
    }

    #[test]
    fn mock_call_tool_returns_error() {
        let mut mock = MockMcpTransport::new();
        mock.expect_call_tool()
            .returning(|name, _args| Err(McpError::ToolNotFound(name.to_string())));

        let result = mock.call_tool("unknown_tool", serde_json::json!({}));
        assert!(matches!(result, Err(McpError::ToolNotFound(_))));
    }
}
