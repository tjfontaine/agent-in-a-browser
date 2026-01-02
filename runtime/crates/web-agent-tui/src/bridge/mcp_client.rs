//! MCP Client
//!
//! Client for communicating with the remote MCP server via HTTP.
//! This keeps the MCP server decoupled from the TUI.

use super::http_client::{HttpClient, HttpError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// MCP tool definition (matches mcp_server.rs structure)
#[derive(Debug, Clone, Serialize, Deserialize)]
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
struct JsonRpcResponse<T> {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: Option<Value>,
    result: Option<T>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i32,
    message: String,
}

/// MCP Client errors
#[derive(Debug, Clone)]
pub enum McpError {
    HttpError(String),
    JsonError(String),
    RpcError(String),
    NotInitialized,
    LockError,
    /// OAuth authentication required - contains server URL for OAuth flow
    OAuthRequired(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
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

// Make McpError Send + Sync by using String instead of nested error types
unsafe impl Send for McpError {}
unsafe impl Sync for McpError {}

impl From<HttpError> for McpError {
    fn from(e: HttpError) -> Self {
        McpError::HttpError(e.to_string())
    }
}

impl From<serde_json::Error> for McpError {
    fn from(e: serde_json::Error) -> Self {
        McpError::JsonError(e.to_string())
    }
}

/// Internal state for the MCP client
struct McpClientInner {
    base_url: String,
    initialized: bool,
    request_id: u64,
}

/// MCP Client for remote tool execution.
///
/// This is a thread-safe wrapper that can be shared across async boundaries.
/// Uses Arc<Mutex> internally to satisfy Send + Sync requirements for rig-core tools.
#[derive(Clone)]
pub struct McpClient {
    inner: Arc<Mutex<McpClientInner>>,
}

impl McpClient {
    /// Create a new MCP client
    pub fn new(base_url: &str) -> Self {
        Self {
            inner: Arc::new(Mutex::new(McpClientInner {
                base_url: base_url.to_string(),
                initialized: false,
                request_id: 1,
            })),
        }
    }

    /// Initialize the MCP connection
    pub fn initialize(&self) -> Result<(), McpError> {
        let mut inner = self.inner.lock().map_err(|_| McpError::LockError)?;

        let request = json!({
            "jsonrpc": "2.0",
            "id": Self::next_id_inner(&mut inner),
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "clientInfo": { "name": "web-agent-tui", "version": "0.1.0" }
            }
        });

        let _response: JsonRpcResponse<Value> = Self::send_request_inner(&inner, &request)?;

        // Send initialized notification
        let notification = json!({
            "jsonrpc": "2.0",
            "id": Self::next_id_inner(&mut inner),
            "method": "initialized",
            "params": {}
        });
        let _: JsonRpcResponse<Value> = Self::send_request_inner(&inner, &notification)?;

        inner.initialized = true;
        Ok(())
    }

    /// List available tools
    pub fn list_tools(&self) -> Result<Vec<ToolDefinition>, McpError> {
        {
            let inner = self.inner.lock().map_err(|_| McpError::LockError)?;
            if !inner.initialized {
                drop(inner);
                self.initialize()?;
            }
        }

        let mut inner = self.inner.lock().map_err(|_| McpError::LockError)?;

        let request = json!({
            "jsonrpc": "2.0",
            "id": Self::next_id_inner(&mut inner),
            "method": "tools/list",
            "params": {}
        });

        #[derive(Deserialize)]
        struct ToolsListResult {
            tools: Vec<ToolDefinition>,
        }

        let response: JsonRpcResponse<ToolsListResult> =
            Self::send_request_inner(&inner, &request)?;

        match response.result {
            Some(result) => Ok(result.tools),
            None => match response.error {
                Some(e) => Err(McpError::RpcError(e.message)),
                None => Ok(vec![]),
            },
        }
    }

    /// Call a tool by name with arguments
    pub fn call_tool(&self, name: &str, arguments: Value) -> Result<String, McpError> {
        {
            let inner = self.inner.lock().map_err(|_| McpError::LockError)?;
            if !inner.initialized {
                drop(inner);
                self.initialize()?;
            }
        }

        let mut inner = self.inner.lock().map_err(|_| McpError::LockError)?;

        let request = json!({
            "jsonrpc": "2.0",
            "id": Self::next_id_inner(&mut inner),
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments
            }
        });

        let response: JsonRpcResponse<ToolResult> = Self::send_request_inner(&inner, &request)?;

        match response.result {
            Some(result) => {
                // Extract text content from result
                let text = result
                    .content
                    .iter()
                    .filter_map(|c| c.text.as_ref())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");

                if result.is_error == Some(true) {
                    Err(McpError::RpcError(text))
                } else {
                    Ok(text)
                }
            }
            None => match response.error {
                Some(e) => Err(McpError::RpcError(e.message)),
                None => Ok(String::new()),
            },
        }
    }

    /// Send a JSON-RPC request and parse response (internal helper)
    fn send_request_inner<T: for<'de> Deserialize<'de>>(
        inner: &McpClientInner,
        request: &Value,
    ) -> Result<JsonRpcResponse<T>, McpError> {
        let url = format!("{}/message", inner.base_url);
        let body = serde_json::to_string(request)?;

        let response = HttpClient::post_json(&url, None, &body)?;

        let parsed: JsonRpcResponse<T> = serde_json::from_slice(&response.body)?;
        Ok(parsed)
    }

    fn next_id_inner(inner: &mut McpClientInner) -> u64 {
        let id = inner.request_id;
        inner.request_id += 1;
        id
    }
}
