//! MCP request handler and McpServer trait

use crate::jsonrpc::{JsonRpcRequest, JsonRpcResponse};
use crate::protocol::{ServerInfo, ToolDefinition, ToolResult};

/// MCP Server trait - implement this to create an MCP server
pub trait McpServer {
    /// Return server information
    fn server_info(&self) -> ServerInfo;

    /// List available tools
    fn list_tools(&self) -> Vec<ToolDefinition>;

    /// Call a tool with the given arguments
    fn call_tool(&mut self, name: &str, arguments: serde_json::Value) -> ToolResult;
}

/// Handle an MCP JSON-RPC request
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

        // Prompts - noop stubs
        "prompts/list" => {
            JsonRpcResponse::success(request.id, serde_json::json!({ "prompts": [] }))
        }

        "prompts/get" => {
            JsonRpcResponse::error(request.id, -32601, "No prompts available".to_string())
        }

        // Logging
        "logging/setLevel" => JsonRpcResponse::success(request.id, serde_json::json!({})),

        // Cancellation - acknowledge but no-op
        "notifications/cancelled" => JsonRpcResponse::success(request.id, serde_json::json!({})),

        _ => JsonRpcResponse::error(
            request.id,
            -32601,
            format!("Method not found: {}", request.method),
        ),
    }
}
