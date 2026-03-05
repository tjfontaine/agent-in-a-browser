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

/// Transport-layer errors (network, HTTP, lock)
#[derive(Debug, Clone)]
pub enum TransportError {
    Network(String),
    Http(String),
    Lock,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Network(e) => write!(f, "Transport error: {}", e),
            TransportError::Http(e) => write!(f, "HTTP error: {}", e),
            TransportError::Lock => write!(f, "Failed to acquire lock"),
        }
    }
}

/// Protocol-layer errors (JSON, RPC, invalid messages)
#[derive(Debug, Clone)]
pub enum ProtocolError {
    Invalid(String),
    Json(String),
    Rpc(String),
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtocolError::Invalid(e) => write!(f, "Protocol error: {}", e),
            ProtocolError::Json(e) => write!(f, "JSON error: {}", e),
            ProtocolError::Rpc(msg) => write!(f, "RPC error: {}", msg),
        }
    }
}

/// Error type for MCP operations
#[derive(Debug, Clone)]
pub enum McpError {
    /// Transport errors (network, HTTP, lock)
    Transport(TransportError),
    /// Protocol errors (JSON, RPC, invalid messages)
    Protocol(ProtocolError),
    /// Tool-related errors
    Tool { name: String, message: String },
    /// Not initialized
    NotInitialized,
    /// OAuth authentication required - contains server URL for OAuth flow
    OAuthRequired(String),
}

// Convenience constructors preserving the old API
#[allow(non_snake_case)]
impl McpError {
    pub fn TransportError(msg: String) -> Self {
        McpError::Transport(TransportError::Network(msg))
    }
    pub fn ProtocolError(msg: String) -> Self {
        McpError::Protocol(ProtocolError::Invalid(msg))
    }
    pub fn ToolNotFound(name: String) -> Self {
        McpError::Tool {
            message: format!("Tool not found: {}", name),
            name,
        }
    }
    pub fn ToolExecutionError(msg: String) -> Self {
        McpError::Tool {
            name: String::new(),
            message: msg,
        }
    }
    pub fn HttpError(msg: String) -> Self {
        McpError::Transport(TransportError::Http(msg))
    }
    pub fn JsonError(msg: String) -> Self {
        McpError::Protocol(ProtocolError::Json(msg))
    }
    pub fn RpcError(msg: String) -> Self {
        McpError::Protocol(ProtocolError::Rpc(msg))
    }
    pub fn LockError() -> Self {
        McpError::Transport(TransportError::Lock)
    }
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::Transport(e) => write!(f, "{}", e),
            McpError::Protocol(e) => write!(f, "{}", e),
            McpError::Tool { name, message } => {
                if name.is_empty() {
                    write!(f, "Tool execution error: {}", message)
                } else if message.starts_with("Tool not found:") {
                    write!(f, "{}", message)
                } else {
                    write!(f, "Tool error ({}): {}", name, message)
                }
            }
            McpError::NotInitialized => write!(f, "MCP client not initialized"),
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
        McpError::Protocol(ProtocolError::Json(e.to_string()))
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
        assert!(matches!(result, Err(McpError::Tool { .. })));
    }

    // ---- McpError Display tests ----

    #[test]
    fn mcp_error_transport_display() {
        let e = McpError::TransportError("connection refused".to_string());
        assert_eq!(e.to_string(), "Transport error: connection refused");
    }

    #[test]
    fn mcp_error_http_display() {
        let e = McpError::HttpError("404 Not Found".to_string());
        assert_eq!(e.to_string(), "HTTP error: 404 Not Found");
    }

    #[test]
    fn mcp_error_lock_display() {
        let e = McpError::LockError();
        assert_eq!(e.to_string(), "Failed to acquire lock");
    }

    #[test]
    fn mcp_error_protocol_display() {
        let e = McpError::ProtocolError("invalid message".to_string());
        assert_eq!(e.to_string(), "Protocol error: invalid message");
    }

    #[test]
    fn mcp_error_json_display() {
        let e = McpError::JsonError("unexpected token".to_string());
        assert_eq!(e.to_string(), "JSON error: unexpected token");
    }

    #[test]
    fn mcp_error_rpc_display() {
        let e = McpError::RpcError("method not found".to_string());
        assert_eq!(e.to_string(), "RPC error: method not found");
    }

    #[test]
    fn mcp_error_tool_not_found_display() {
        let e = McpError::ToolNotFound("shell_eval".to_string());
        assert_eq!(e.to_string(), "Tool not found: shell_eval");
    }

    #[test]
    fn mcp_error_tool_execution_display() {
        let e = McpError::ToolExecutionError("timeout".to_string());
        assert_eq!(e.to_string(), "Tool execution error: timeout");
    }

    #[test]
    fn mcp_error_not_initialized_display() {
        let e = McpError::NotInitialized;
        assert_eq!(e.to_string(), "MCP client not initialized");
    }

    #[test]
    fn mcp_error_oauth_display() {
        let e = McpError::OAuthRequired("https://example.com".to_string());
        assert_eq!(e.to_string(), "OAuth required for https://example.com");
    }

    #[test]
    fn mcp_error_from_serde_json() {
        let json_err: Result<serde_json::Value, _> = serde_json::from_str("invalid");
        let mcp_err: McpError = json_err.unwrap_err().into();
        assert!(mcp_err.to_string().starts_with("JSON error:"));
    }

    #[test]
    fn mcp_error_nested_variants() {
        // Verify nested enum structure is accessible
        let transport = McpError::Transport(TransportError::Network("test".into()));
        assert!(matches!(
            transport,
            McpError::Transport(TransportError::Network(_))
        ));

        let protocol = McpError::Protocol(ProtocolError::Rpc("test".into()));
        assert!(matches!(
            protocol,
            McpError::Protocol(ProtocolError::Rpc(_))
        ));

        let tool = McpError::Tool {
            name: "test".into(),
            message: "failed".into(),
        };
        assert!(matches!(tool, McpError::Tool { .. }));
    }
}
