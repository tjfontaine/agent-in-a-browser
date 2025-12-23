//! Minimal MCP (Model Context Protocol) server implementation.
//!
//! This implements the JSON-RPC 2.0 based MCP protocol for stdio communication.
//! Designed to be lightweight and WASM-compatible without heavy async runtime deps.

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};

/// JSON-RPC 2.0 Request
#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    #[allow(dead_code)] // part of JSON-RPC protocol but validated by serde
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

/// MCP Log Level for notifications/message
#[allow(dead_code)] // part of MCP protocol, used for SSE/streaming
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Notice,
    Warning,
    Error,
    Critical,
    Alert,
    Emergency,
}

impl Default for LogLevel {
    fn default() -> Self {
        LogLevel::Info
    }
}

/// MCP Log Message for notifications/message notification
#[allow(dead_code)] // part of MCP protocol, used for SSE/streaming
#[derive(Debug, Serialize)]
pub struct LogMessage {
    pub level: LogLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logger: Option<String>,
    pub data: serde_json::Value,
}

#[allow(dead_code)] // MCP protocol helpers for SSE/streaming
impl LogMessage {
    /// Create a log message with the given level and data
    pub fn new(level: LogLevel, data: impl Into<serde_json::Value>) -> Self {
        Self {
            level,
            logger: None,
            data: data.into(),
        }
    }

    /// Create an info-level log message
    pub fn info(message: impl Into<String>) -> Self {
        Self::new(LogLevel::Info, serde_json::json!({ "message": message.into() }))
    }

    /// Create an error-level log message
    pub fn error(message: impl Into<String>) -> Self {
        Self::new(LogLevel::Error, serde_json::json!({ "message": message.into() }))
    }

    /// Create a debug-level log message
    pub fn debug(message: impl Into<String>) -> Self {
        Self::new(LogLevel::Debug, serde_json::json!({ "message": message.into() }))
    }
}

/// JSON-RPC Notification (no id, no response expected)
#[allow(dead_code)] // part of MCP protocol, used for SSE/streaming
#[derive(Debug, Serialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: serde_json::Value,
}

#[allow(dead_code)] // MCP protocol helpers for SSE/streaming
impl JsonRpcNotification {
    /// Create a notifications/message notification
    pub fn log_message(message: LogMessage) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: "notifications/message".to_string(),
            params: serde_json::to_value(message).unwrap_or_default(),
        }
    }

    /// Create a notifications/progress notification
    /// progress_token: Token from either the request's _meta.progressToken or server-generated
    /// progress: Current progress (0.0 to 1.0 or custom scale)
    /// total: Optional total for denominator
    /// message: Optional status message
    pub fn progress(
        progress_token: impl Into<String>,
        progress: f64,
        total: Option<f64>,
        message: Option<String>,
    ) -> Self {
        let mut params = serde_json::json!({
            "progressToken": progress_token.into(),
            "progress": progress
        });
        if let Some(t) = total {
            params["total"] = serde_json::json!(t);
        }
        if let Some(m) = message {
            params["message"] = serde_json::json!(m);
        }
        Self {
            jsonrpc: "2.0".to_string(),
            method: "notifications/progress".to_string(),
            params,
        }
    }

    /// Serialize to SSE event format
    pub fn to_sse_event(&self) -> String {
        let data = serde_json::to_string(self).unwrap_or_default();
        format!("event: message\ndata: {}\n\n", data)
    }
}

/// MCP Tool Annotations - hints about tool behavior per 2025-11-25 spec
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    /// If true, the tool does not modify any state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    /// If true, the tool may perform destructive operations
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    /// If true, calling this tool multiple times with same args has same effect
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
    /// If true, the tool interacts with external systems
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_world_hint: Option<bool>,
}

/// MCP Tool Definition - extended for 2025-11-25 spec
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    /// Human-readable display name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// JSON Schema for expected output structure
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
    /// Hints about tool behavior
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<ToolAnnotations>,
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

/// Tool content item - text, image, audio, resource, or resource_link
/// Extended for MCP 2025-11-25 spec compliance
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    /// Text content (for type: "text")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Base64 encoded data (for type: "image", "audio")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// MIME type (for type: "image", "audio")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Resource URI (for type: "resource", "resource_link")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// Resource name (for type: "resource", "resource_link")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Resource title (for type: "resource", "resource_link")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl ToolContent {
    /// Create a text content item
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content_type: "text".to_string(),
            text: Some(text.into()),
            data: None,
            mime_type: None,
            uri: None,
            name: None,
            title: None,
        }
    }
    
    /// Create an image content item (base64 encoded)
    #[allow(dead_code)] // MCP protocol content type
    pub fn image(data: impl Into<String>, mime_type: impl Into<String>) -> Self {
        Self {
            content_type: "image".to_string(),
            text: None,
            data: Some(data.into()),
            mime_type: Some(mime_type.into()),
            uri: None,
            name: None,
            title: None,
        }
    }

    /// Create an audio content item (base64 encoded)
    #[allow(dead_code)] // MCP protocol content type
    pub fn audio(data: impl Into<String>, mime_type: impl Into<String>) -> Self {
        Self {
            content_type: "audio".to_string(),
            text: None,
            data: Some(data.into()),
            mime_type: Some(mime_type.into()),
            uri: None,
            name: None,
            title: None,
        }
    }

    /// Create an embedded resource content item
    #[allow(dead_code)] // MCP protocol content type
    pub fn resource(uri: impl Into<String>, text: impl Into<String>, mime_type: Option<String>) -> Self {
        Self {
            content_type: "resource".to_string(),
            text: Some(text.into()),
            data: None,
            mime_type,
            uri: Some(uri.into()),
            name: None,
            title: None,
        }
    }

    /// Create a resource link (reference without content)
    #[allow(dead_code)] // MCP protocol content type
    pub fn resource_link(uri: impl Into<String>, name: Option<String>, title: Option<String>) -> Self {
        Self {
            content_type: "resource_link".to_string(),
            text: None,
            data: None,
            mime_type: None,
            uri: Some(uri.into()),
            name,
            title,
        }
    }
}

impl ToolResult {
    /// Create a successful tool result with content items (rmcp-compatible)
    #[allow(dead_code)] // MCP protocol helper
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
    #[allow(dead_code)] // MCP protocol helper
    pub fn structured(value: serde_json::Value) -> Self {
        Self {
            content: vec![],
            is_error: None,
            structured_content: Some(value),
            meta: None,
        }
    }
    
    /// Create an error tool result with structured JSON content (rmcp-compatible)
    #[allow(dead_code)] // MCP protocol helper
    pub fn structured_error(value: serde_json::Value) -> Self {
        Self {
            content: vec![],
            is_error: Some(true),
            structured_content: Some(value),
            meta: None,
        }
    }
    
    /// Add metadata to this result
    #[allow(dead_code)] // MCP protocol helper
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
#[allow(dead_code)] // alternative entry point for stdio mode
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
                "protocolVersion": "2025-11-25",
                "capabilities": {
                    "tools": {},
                    "resources": {},
                    "prompts": {},
                    "logging": {}
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

        "ping" => {
            // Health check - return empty object
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

        // Resources - noop stubs per spec
        "resources/list" => {
            JsonRpcResponse::success(request.id, serde_json::json!({ "resources": [] }))
        }

        "resources/read" => {
            JsonRpcResponse::error(request.id, -32601, "Resources not supported".to_string())
        }

        "resources/templates/list" => {
            JsonRpcResponse::success(request.id, serde_json::json!({ "resourceTemplates": [] }))
        }

        // Prompts - noop stubs (generic agent composes tools)
        "prompts/list" => {
            JsonRpcResponse::success(request.id, serde_json::json!({ "prompts": [] }))
        }

        "prompts/get" => {
            JsonRpcResponse::error(request.id, -32601, "No prompts available".to_string())
        }

        // Logging
        "logging/setLevel" => {
            // Accept the level but we don't have state management yet
            // Future: store level and filter notifications/message
            JsonRpcResponse::success(request.id, serde_json::json!({}))
        }

        // Cancellation - acknowledge but no-op for now
        // Breadcrumb: track in-flight request IDs, pass cancellation token to tools
        // For QuickJS: investigate ctx.interrupt_handler() for cooperative cancellation
        "notifications/cancelled" => {
            // This is a notification, no response expected
            // Future: mark request.params.requestId as cancelled
            JsonRpcResponse::success(request.id, serde_json::json!({}))
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

    // ============================================================
    // MCP 2025-11-25 Specification Tests
    // ============================================================

    #[test]
    fn test_tool_definition_extended() {
        let tool = ToolDefinition {
            name: "test_tool".to_string(),
            description: "A test tool".to_string(),
            input_schema: json!({"type": "object"}),
            title: Some("Test Tool".to_string()),
            output_schema: Some(json!({"type": "string"})),
            annotations: Some(ToolAnnotations {
                read_only_hint: Some(true),
                destructive_hint: None,
                idempotent_hint: Some(true),
                open_world_hint: None,
            }),
        };
        
        let serialized = serde_json::to_string(&tool).unwrap();
        assert!(serialized.contains("\"title\":\"Test Tool\""));
        assert!(serialized.contains("\"outputSchema\""));
        assert!(serialized.contains("\"readOnlyHint\":true"));
        assert!(serialized.contains("\"idempotentHint\":true"));
        // Skipped fields should not appear
        assert!(!serialized.contains("\"destructiveHint\""));
        assert!(!serialized.contains("\"openWorldHint\""));
    }

    #[test]
    fn test_tool_definition_minimal() {
        let tool = ToolDefinition {
            name: "minimal".to_string(),
            description: "Minimal tool".to_string(),
            input_schema: json!({"type": "object"}),
            title: None,
            output_schema: None,
            annotations: None,
        };
        
        let serialized = serde_json::to_string(&tool).unwrap();
        assert!(serialized.contains("\"name\":\"minimal\""));
        // Optional fields should not appear when None
        assert!(!serialized.contains("\"title\""));
        assert!(!serialized.contains("\"outputSchema\""));
        assert!(!serialized.contains("\"annotations\""));
    }

    #[test]
    fn test_tool_annotations_default() {
        let annotations = ToolAnnotations::default();
        assert!(annotations.read_only_hint.is_none());
        assert!(annotations.destructive_hint.is_none());
        assert!(annotations.idempotent_hint.is_none());
        assert!(annotations.open_world_hint.is_none());
    }
}

