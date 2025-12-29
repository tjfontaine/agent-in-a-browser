//! MCP Client
//!
//! Client for communicating with the remote MCP server via HTTP.
//! This keeps the MCP server decoupled from the TUI.

use super::http_client::{HttpClient, HttpError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
#[derive(Debug)]
pub enum McpError {
    HttpError(HttpError),
    JsonError(serde_json::Error),
    RpcError(String),
    NotInitialized,
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::HttpError(e) => write!(f, "HTTP error: {}", e),
            McpError::JsonError(e) => write!(f, "JSON error: {}", e),
            McpError::RpcError(msg) => write!(f, "RPC error: {}", msg),
            McpError::NotInitialized => write!(f, "MCP client not initialized"),
        }
    }
}

impl std::error::Error for McpError {}

impl From<HttpError> for McpError {
    fn from(e: HttpError) -> Self {
        McpError::HttpError(e)
    }
}

impl From<serde_json::Error> for McpError {
    fn from(e: serde_json::Error) -> Self {
        McpError::JsonError(e)
    }
}

/// MCP Client for remote tool execution
pub struct McpClient {
    base_url: String,
    initialized: bool,
    request_id: u64,
}

impl McpClient {
    /// Create a new MCP client
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            initialized: false,
            request_id: 1,
        }
    }

    /// Initialize the MCP connection
    pub fn initialize(&mut self) -> Result<(), McpError> {
        let request = json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "clientInfo": { "name": "web-agent-tui", "version": "0.1.0" }
            }
        });

        let _response: JsonRpcResponse<Value> = self.send_request(&request)?;
        
        // Send initialized notification
        let notification = json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": "initialized",
            "params": {}
        });
        let _: JsonRpcResponse<Value> = self.send_request(&notification)?;

        self.initialized = true;
        Ok(())
    }

    /// List available tools
    pub fn list_tools(&mut self) -> Result<Vec<ToolDefinition>, McpError> {
        if !self.initialized {
            self.initialize()?;
        }

        let request = json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": "tools/list",
            "params": {}
        });

        #[derive(Deserialize)]
        struct ToolsListResult {
            tools: Vec<ToolDefinition>,
        }

        let response: JsonRpcResponse<ToolsListResult> = self.send_request(&request)?;
        
        match response.result {
            Some(result) => Ok(result.tools),
            None => match response.error {
                Some(e) => Err(McpError::RpcError(e.message)),
                None => Ok(vec![]),
            }
        }
    }

    /// Call a tool by name with arguments
    pub fn call_tool(&mut self, name: &str, arguments: Value) -> Result<String, McpError> {
        if !self.initialized {
            self.initialize()?;
        }

        let request = json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments
            }
        });

        let response: JsonRpcResponse<ToolResult> = self.send_request(&request)?;
        
        match response.result {
            Some(result) => {
                // Extract text content from result
                let text = result.content
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
            }
        }
    }

    /// Send a JSON-RPC request and parse response
    fn send_request<T: for<'de> Deserialize<'de>>(&self, request: &Value) -> Result<JsonRpcResponse<T>, McpError> {
        let url = format!("{}/message", self.base_url);
        let body = serde_json::to_string(request)?;
        
        let response = HttpClient::post_json(&url, None, &body)?;
        
        let parsed: JsonRpcResponse<T> = serde_json::from_slice(&response.body)?;
        Ok(parsed)
    }

    fn next_id(&mut self) -> u64 {
        let id = self.request_id;
        self.request_id += 1;
        id
    }
}
