//! Minimal MCP (Model Context Protocol) server implementation.
//!
//! This implements the JSON-RPC 2.0 based MCP protocol for stdio communication.
//! Designed to be lightweight and WASM-compatible without heavy async runtime deps.

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};

/// JSON-RPC 2.0 Request
#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// JSON-RPC 2.0 Response
#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl JsonRpcResponse {
    pub fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<serde_json::Value>, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message,
                data: None,
            }),
        }
    }
}

/// MCP Server Info
#[derive(Debug, Serialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

/// MCP Tool Definition
#[derive(Debug, Serialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
}

/// MCP Tool Result - aligned with rmcp's CallToolResult
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    /// The content returned by the tool (text, images, etc.)
    pub content: Vec<ToolContent>,
    /// Whether this result represents an error condition
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// An optional JSON object that represents the structured result of the tool call
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<serde_json::Value>,
    /// Optional protocol-level metadata for this result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

/// Tool content item - text, image, or other content types
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

impl ToolContent {
    /// Create a text content item
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content_type: "text".to_string(),
            text: Some(text.into()),
            data: None,
            mime_type: None,
        }
    }
    
    /// Create an image content item (base64 encoded)
    pub fn image(data: impl Into<String>, mime_type: impl Into<String>) -> Self {
        Self {
            content_type: "image".to_string(),
            text: None,
            data: Some(data.into()),
            mime_type: Some(mime_type.into()),
        }
    }
}

impl ToolResult {
    /// Create a successful tool result with content items (rmcp-compatible)
    pub fn success(content: Vec<ToolContent>) -> Self {
        Self {
            content,
            is_error: None,
            structured_content: None,
            meta: None,
        }
    }

    /// Create a successful tool result with a single text content item
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::text(text)],
            is_error: None,
            structured_content: None,
            meta: None,
        }
    }

    /// Create an error tool result with a message
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::text(message)],
            is_error: Some(true),
            structured_content: None,
            meta: None,
        }
    }
    
    /// Create a successful tool result with structured JSON content (rmcp-compatible)
    pub fn structured(value: serde_json::Value) -> Self {
        Self {
            content: vec![],
            is_error: None,
            structured_content: Some(value),
            meta: None,
        }
    }
    
    /// Create an error tool result with structured JSON content (rmcp-compatible)
    pub fn structured_error(value: serde_json::Value) -> Self {
        Self {
            content: vec![],
            is_error: Some(true),
            structured_content: Some(value),
            meta: None,
        }
    }
    
    /// Add metadata to this result
    pub fn with_meta(mut self, meta: serde_json::Value) -> Self {
        self.meta = Some(meta);
        self
    }
}

/// MCP Server trait - implement this to create an MCP server
pub trait McpServer {
    fn server_info(&self) -> ServerInfo;
    fn list_tools(&self) -> Vec<ToolDefinition>;
    fn call_tool(&mut self, name: &str, arguments: serde_json::Value) -> ToolResult;
}

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

pub fn handle_request<S: McpServer>(server: &mut S, request: JsonRpcRequest) -> JsonRpcResponse {
    match request.method.as_str() {
        "initialize" => {
            let info = server.server_info();
            let result = serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": info.name,
                    "version": info.version
                }
            });
            JsonRpcResponse::success(request.id, result)
        }

        "initialized" => {
            // Notification, no response needed but we send empty result
            JsonRpcResponse::success(request.id, serde_json::json!({}))
        }

        "tools/list" => {
            let tools = server.list_tools();
            let result = serde_json::json!({
                "tools": tools
            });
            JsonRpcResponse::success(request.id, result)
        }

        "tools/call" => {
            let name = request.params.get("name").and_then(|v| v.as_str());
            let arguments = request
                .params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));

            match name {
                Some(name) => {
                    let result = server.call_tool(name, arguments);
                    JsonRpcResponse::success(request.id, serde_json::to_value(result).unwrap())
                }
                None => JsonRpcResponse::error(request.id, -32602, "Missing tool name".to_string()),
            }
        }

        _ => JsonRpcResponse::error(
            request.id,
            -32601,
            format!("Method not found: {}", request.method),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_tool_result_text() {
        let result = ToolResult::text("hello");
        assert_eq!(result.content.len(), 1);
        assert_eq!(result.content[0].text, Some("hello".to_string()));
        assert_eq!(result.content[0].content_type, "text");
        assert!(result.is_error.is_none());
        assert!(result.structured_content.is_none());
        assert!(result.meta.is_none());
    }

    #[test]
    fn test_tool_result_error() {
        let result = ToolResult::error("something went wrong");
        assert_eq!(result.content.len(), 1);
        assert_eq!(result.content[0].text, Some("something went wrong".to_string()));
        assert_eq!(result.is_error, Some(true));
    }

    #[test]
    fn test_tool_result_success() {
        let result = ToolResult::success(vec![
            ToolContent::text("line 1"),
            ToolContent::text("line 2"),
        ]);
        assert_eq!(result.content.len(), 2);
        assert!(result.is_error.is_none());
    }

    #[test]
    fn test_tool_result_structured() {
        let result = ToolResult::structured(json!({"foo": "bar", "count": 42}));
        assert!(result.content.is_empty());
        assert!(result.is_error.is_none());
        assert_eq!(result.structured_content, Some(json!({"foo": "bar", "count": 42})));
    }

    #[test]
    fn test_tool_result_structured_error() {
        let result = ToolResult::structured_error(json!({"error_code": "INVALID_INPUT"}));
        assert!(result.content.is_empty());
        assert_eq!(result.is_error, Some(true));
        assert!(result.structured_content.is_some());
    }

    #[test]
    fn test_tool_result_with_meta() {
        let result = ToolResult::text("test")
            .with_meta(json!({"progress_token": "abc123"}));
        assert!(result.meta.is_some());
        assert_eq!(result.meta.unwrap()["progress_token"], "abc123");
    }

    #[test]
    fn test_tool_content_image() {
        let content = ToolContent::image("base64data==", "image/png");
        assert_eq!(content.content_type, "image");
        assert_eq!(content.data, Some("base64data==".to_string()));
        assert_eq!(content.mime_type, Some("image/png".to_string()));
        assert!(content.text.is_none());
    }

    #[test]
    fn test_tool_result_serialization() {
        let result = ToolResult::text("test");
        let json = serde_json::to_string(&result).unwrap();
        // Should have content array
        assert!(json.contains("\"content\""));
        // Should NOT have isError when None (skip_serializing_if)
        assert!(!json.contains("\"isError\""));
        // Should NOT have structuredContent when None
        assert!(!json.contains("\"structuredContent\""));
        // Should NOT have meta when None
        assert!(!json.contains("\"meta\""));
    }

    #[test]
    fn test_tool_result_serialization_with_error() {
        let result = ToolResult::error("failed");
        let json = serde_json::to_string(&result).unwrap();
        // Should have isError when true
        assert!(json.contains("\"isError\":true"));
    }

    #[test]
    fn test_json_rpc_request_parsing() {
        let json = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"test"}}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.method, "tools/call");
        assert_eq!(req.params["name"], "test");
    }

    #[test]
    fn test_json_rpc_response_success() {
        let resp = JsonRpcResponse::success(Some(json!(1)), json!({"result": "ok"}));
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"jsonrpc\":\"2.0\""));
        assert!(json.contains("\"id\":1"));
        assert!(json.contains("\"result\""));
        assert!(!json.contains("\"error\""));
    }

    #[test]
    fn test_json_rpc_response_error() {
        let resp = JsonRpcResponse::error(Some(json!(1)), -32600, "Invalid Request".to_string());
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"error\""));
        assert!(json.contains("-32600"));
        assert!(!json.contains("\"result\""));
    }
}
