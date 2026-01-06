//! MCP Client for Headless Agent
//!
//! Simple MCP client that communicates with the sandbox MCP server via HTTP.
//! Implements agent_bridge::McpTransport for use with shared tool adapters.

use agent_bridge::{McpError, McpTransport, ToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

use super::http_client::HttpClient;

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

/// MCP tool definition (from server)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpToolDefinition {
    name: String,
    description: String,
    input_schema: Value,
}

/// MCP tool result content
#[derive(Debug, Clone, Deserialize)]
struct ToolContent {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

/// MCP tool result
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolResult {
    content: Vec<ToolContent>,
    is_error: Option<bool>,
}

/// Internal state
struct McpClientInner {
    base_url: String,
    initialized: bool,
    request_id: u64,
}

/// MCP Client for the headless agent sandbox.
///
/// Thread-safe wrapper using Arc<Mutex>.
#[derive(Clone)]
pub struct SandboxMcpClient {
    inner: Arc<Mutex<McpClientInner>>,
}

impl SandboxMcpClient {
    /// Create a new MCP client for the sandbox
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
    fn initialize(&self) -> Result<(), McpError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| McpError::TransportError("Lock error".to_string()))?;

        if inner.initialized {
            return Ok(());
        }

        let request = json!({
            "jsonrpc": "2.0",
            "id": Self::next_id(&mut inner),
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "clientInfo": { "name": "web-headless-agent", "version": "0.1.0" }
            }
        });

        let _response: JsonRpcResponse<Value> = self.send_request_inner(&inner, &request)?;

        // Send initialized notification
        let notification = json!({
            "jsonrpc": "2.0",
            "id": Self::next_id(&mut inner),
            "method": "initialized",
            "params": {}
        });
        let _: JsonRpcResponse<Value> = self.send_request_inner(&inner, &notification)?;

        inner.initialized = true;
        Ok(())
    }

    fn send_request_inner<T: for<'de> Deserialize<'de>>(
        &self,
        inner: &McpClientInner,
        request: &Value,
    ) -> Result<JsonRpcResponse<T>, McpError> {
        let url = format!("{}/message", inner.base_url);
        let body =
            serde_json::to_string(request).map_err(|e| McpError::ProtocolError(e.to_string()))?;

        let response = HttpClient::post_json(&url, None, &body)
            .map_err(|e| McpError::TransportError(e.to_string()))?;

        serde_json::from_slice(&response.body).map_err(|e| McpError::ProtocolError(e.to_string()))
    }

    fn next_id(inner: &mut McpClientInner) -> u64 {
        let id = inner.request_id;
        inner.request_id += 1;
        id
    }
}

impl McpTransport for SandboxMcpClient {
    fn list_tools(&self) -> Result<Vec<ToolDefinition>, McpError> {
        self.initialize()?;

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| McpError::TransportError("Lock error".to_string()))?;

        let request = json!({
            "jsonrpc": "2.0",
            "id": Self::next_id(&mut inner),
            "method": "tools/list",
            "params": {}
        });

        #[derive(Deserialize)]
        struct ToolsListResult {
            tools: Vec<McpToolDefinition>,
        }

        let response: JsonRpcResponse<ToolsListResult> =
            self.send_request_inner(&inner, &request)?;

        match response.result {
            Some(result) => Ok(result
                .tools
                .into_iter()
                .map(|t| ToolDefinition {
                    name: t.name,
                    description: t.description,
                    input_schema: t.input_schema,
                })
                .collect()),
            None => match response.error {
                Some(e) => Err(McpError::ProtocolError(e.message)),
                None => Ok(vec![]),
            },
        }
    }

    fn call_tool(&self, name: &str, arguments: Value) -> Result<String, McpError> {
        self.initialize()?;

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| McpError::TransportError("Lock error".to_string()))?;

        let request = json!({
            "jsonrpc": "2.0",
            "id": Self::next_id(&mut inner),
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments
            }
        });

        let response: JsonRpcResponse<ToolResult> = self.send_request_inner(&inner, &request)?;

        match response.result {
            Some(result) => {
                let text = result
                    .content
                    .iter()
                    .filter_map(|c| c.text.as_ref())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");

                if result.is_error == Some(true) {
                    Err(McpError::ToolExecutionError(text))
                } else {
                    Ok(text)
                }
            }
            None => match response.error {
                Some(e) => Err(McpError::ProtocolError(e.message)),
                None => Ok(String::new()),
            },
        }
    }
}
