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

/// MCP Tool Result
#[derive(Debug, Serialize)]
pub struct ToolResult {
    pub content: Vec<ToolContent>,
    #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: String,
}

impl ToolResult {
    pub fn text(text: String) -> Self {
        Self {
            content: vec![ToolContent {
                content_type: "text".to_string(),
                text,
            }],
            is_error: None,
        }
    }

    pub fn error(message: String) -> Self {
        Self {
            content: vec![ToolContent {
                content_type: "text".to_string(),
                text: message,
            }],
            is_error: Some(true),
        }
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
