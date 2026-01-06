//! Remote MCP Client
//!
//! Client for connecting to remote MCP servers via Streamable HTTP transport.
//! Implements MCP 2025-11-25 specification.
//!
//! See: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http

use crate::http_transport::{HttpError, HttpTransport};
use crate::mcp_transport::{JsonRpcResponse, McpError, McpTransport, ToolDefinition, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// MCP protocol version we support
const PROTOCOL_VERSION: &str = "2025-11-25";

/// Get the effective URL for the request
/// Note: CORS proxy rewriting is handled by the TypeScript WASI HTTP shim
/// which has access to window.location.origin for constructing absolute URLs
fn get_effective_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

/// Remote MCP Client for Streamable HTTP transport
///
/// Implements MCP 2025-11-25 specification with:
/// - Accept header supporting both JSON and SSE
/// - MCP-Protocol-Version header
/// - MCP-Session-Id management
/// - Bearer token authentication
pub struct RemoteMcpClient<T: HttpTransport> {
    transport: T,
    base_url: String,
    bearer_token: Option<String>,
    session_id: Option<String>,
    request_id: u64,
    initialized: bool,
}

impl<T: HttpTransport> RemoteMcpClient<T> {
    /// Create a new remote MCP client
    pub fn new(transport: T, url: &str, bearer_token: Option<String>) -> Self {
        Self {
            transport,
            base_url: url.trim_end_matches('/').to_string(),
            bearer_token,
            session_id: None,
            request_id: 1,
            initialized: false,
        }
    }

    /// Connect to the MCP server and return available tools
    ///
    /// Performs the MCP initialization handshake:
    /// 1. Send `initialize` request with capabilities
    /// 2. Parse session ID from response headers
    /// 3. Send `notifications/initialized`
    /// 4. Request `tools/list`
    pub fn connect(&mut self) -> Result<Vec<ToolDefinition>, McpError> {
        // 1. Send initialize request
        let init_request = json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {
                    "tools": {}
                },
                "clientInfo": {
                    "name": "web-agent",
                    "version": "0.1.0"
                }
            }
        });

        let _init_response: JsonRpcResponse<Value> = self.send_request(&init_request)?;
        self.initialized = true;

        // 2. Send initialized notification
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        // Notifications don't return a response, but we send it as POST anyway
        let _ = self.send_notification(&notification);

        // 3. Fetch tools list
        self.list_tools()
    }

    /// List available tools from the server
    pub fn list_tools(&self) -> Result<Vec<ToolDefinition>, McpError> {
        let request = json!({
            "jsonrpc": "2.0",
            "id": self.request_id,
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
            },
        }
    }

    /// Call a tool on the remote server
    pub fn call_tool(&self, name: &str, arguments: Value) -> Result<String, McpError> {
        let request = json!({
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments
            }
        });

        let response: JsonRpcResponse<ToolResult> = self.send_request(&request)?;

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

    /// Send a JSON-RPC request and parse response
    fn send_request<R: for<'de> Deserialize<'de>>(
        &self,
        request: &Value,
    ) -> Result<JsonRpcResponse<R>, McpError> {
        let url = get_effective_url(&self.base_url, "");
        let body = serde_json::to_string(request)?;

        // Build headers per MCP 2025-11-25 spec
        let mut headers = vec![
            ("Content-Type", "application/json"),
            // MUST include both JSON and SSE in Accept header
            ("Accept", "application/json, text/event-stream"),
            // Protocol version header
            ("MCP-Protocol-Version", PROTOCOL_VERSION),
        ];

        // Bearer token authentication
        let auth_header;
        if let Some(ref token) = self.bearer_token {
            auth_header = format!("Bearer {}", token);
            headers.push(("Authorization", &auth_header));
        }

        // Session ID (if we have one from initialization)
        let session_header;
        if let Some(ref session) = self.session_id {
            session_header = session.clone();
            headers.push(("MCP-Session-Id", &session_header));
        }

        let response = self
            .transport
            .post(&url, &headers, body.as_bytes())
            .map_err(|e| McpError::HttpError(e.to_string()))?;

        // TODO: Parse MCP-Session-Id from response headers if present
        // Currently HttpTransport usage might not expose headers easily without updating HttpResponse

        // Check for 401 Unauthorized - OAuth required
        if response.status == 401 {
            // Return OAuthRequired error with server URL for OAuth flow
            return Err(McpError::OAuthRequired(self.base_url.clone()));
        }

        if response.status >= 400 {
            return Err(McpError::HttpError(format!(
                "HTTP {} - {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            )));
        }

        let parsed: JsonRpcResponse<R> = serde_json::from_slice(&response.body)?;
        Ok(parsed)
    }

    /// Send a notification (no response expected)
    fn send_notification(&self, notification: &Value) -> Result<(), McpError> {
        let url = get_effective_url(&self.base_url, "");
        let body = serde_json::to_string(notification)?;

        let mut headers = vec![
            ("Content-Type", "application/json"),
            ("Accept", "application/json, text/event-stream"),
            ("MCP-Protocol-Version", PROTOCOL_VERSION),
        ];

        let auth_header;
        if let Some(ref token) = self.bearer_token {
            auth_header = format!("Bearer {}", token);
            headers.push(("Authorization", &auth_header));
        }

        let session_header;
        if let Some(ref session) = self.session_id {
            session_header = session.clone();
            headers.push(("MCP-Session-Id", &session_header));
        }

        let response = self
            .transport
            .post(&url, &headers, body.as_bytes())
            .map_err(|e| McpError::HttpError(e.to_string()))?;

        // Notifications should return 202 Accepted
        if response.status != 202 && response.status >= 400 {
            return Err(McpError::HttpError(format!(
                "Notification failed: HTTP {}",
                response.status
            )));
        }

        Ok(())
    }

    fn next_id(&mut self) -> u64 {
        let id = self.request_id;
        self.request_id += 1;
        id
    }
}

impl<T: HttpTransport + Send + Sync> McpTransport for RemoteMcpClient<T> {
    fn list_tools(&self) -> Result<Vec<ToolDefinition>, McpError> {
        self.list_tools()
    }

    fn call_tool(&self, name: &str, arguments: Value) -> Result<String, McpError> {
        self.call_tool(name, arguments)
    }
}
