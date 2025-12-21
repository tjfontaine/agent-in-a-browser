//! MCP HTTP Server
//!
//! Implements wasi:http/incoming-handler to serve MCP protocol over HTTP.
//! Uses cargo-component bindings for WASI interfaces.

mod bindings;
mod host_bindings;
mod http_client;
mod loader;
mod mcp_server;
mod opfs;
mod resolver;
mod transpiler;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{
    Fields, IncomingRequest, OutgoingBody, OutgoingResponse, ResponseOutparam,
};
use mcp_server::{
    JsonRpcRequest, JsonRpcResponse, McpServer, ServerInfo, ToolDefinition, ToolResult,
};
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt};
use serde_json::json;
use std::cell::RefCell;

/// The TypeScript Runtime MCP Server (thread-local, single-threaded)
struct TsRuntimeMcp {
    runtime: AsyncRuntime,
    context: AsyncContext,
}

thread_local! {
    static MCP_SERVER: RefCell<Option<TsRuntimeMcp>> = RefCell::new(None);
}

impl TsRuntimeMcp {
    pub fn new() -> Result<Self, String> {
        let runtime =
            AsyncRuntime::new().map_err(|e| format!("Failed to create runtime: {}", e))?;
        let context = futures_lite::future::block_on(AsyncContext::full(&runtime))
            .map_err(|e| format!("Failed to create context: {}", e))?;

        futures_lite::future::block_on(context.with(|ctx| {
            host_bindings::install_console(&ctx)?;
            host_bindings::install_path(&ctx)?;
            host_bindings::install_fs(&ctx)?;
            host_bindings::install_fetch(&ctx)?;
            Ok::<(), rquickjs::Error>(())
        }))
        .map_err(|e| format!("Failed to install bindings: {}", e))?;

        futures_lite::future::block_on(
            runtime.set_loader(resolver::HybridResolver, loader::HybridLoader),
        );

        Ok(Self { runtime, context })
    }

    fn eval_code(&mut self, code: &str) -> Result<String, String> {
        host_bindings::clear_logs();

        let js_code = if code.contains(": ") || code.contains("<") || code.ends_with(".ts") {
            transpiler::transpile(code)?
        } else {
            code.to_string()
        };

        futures_lite::future::block_on(self.context.with(|ctx| {
            let result = ctx.eval::<rquickjs::Value, _>(js_code.as_bytes());
            match result.catch(&ctx) {
                Ok(val) => {
                    if val.is_undefined() {
                        let logs = host_bindings::get_logs();
                        if logs.is_empty() {
                            Ok("undefined".to_string())
                        } else {
                            Ok(logs)
                        }
                    } else if let Some(s) = val.as_string() {
                        Ok(s.to_string().unwrap_or_default())
                    } else if let Some(n) = val.as_number() {
                        Ok(format!("{}", n))
                    } else if let Some(b) = val.as_bool() {
                        Ok(format!("{}", b))
                    } else {
                        let json_global = ctx.globals();
                        if let Ok(json_obj) = json_global.get::<_, rquickjs::Object>("JSON") {
                            if let Ok(stringify) =
                                json_obj.get::<_, rquickjs::Function>("stringify")
                            {
                                if let Ok(result) = stringify.call::<_, String>((val.clone(),)) {
                                    return Ok(result);
                                }
                            }
                        }
                        Ok("[object]".to_string())
                    }
                }
                Err(e) => Err(format!("Evaluation error: {:?}", e)),
            }
        }))
    }

    fn transpile_code(&self, code: &str) -> Result<String, String> {
        transpiler::transpile(code)
    }

    fn read_file(&self, path: &str) -> Result<String, String> {
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {}", path, e))
    }

    fn write_file(&self, path: &str, content: &str) -> Result<(), String> {
        std::fs::write(path, content).map_err(|e| format!("Failed to write {}: {}", path, e))
    }

    fn list_dir(&self, path: &str) -> Result<Vec<String>, String> {
        let entries =
            std::fs::read_dir(path).map_err(|e| format!("Failed to list {}: {}", path, e))?;
        let mut result = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                result.push(format!("{}/", name));
            } else {
                result.push(name);
            }
        }
        Ok(result)
    }
}

impl McpServer for TsRuntimeMcp {
    fn server_info(&self) -> ServerInfo {
        ServerInfo {
            name: "ts-runtime".to_string(),
            version: "0.1.0".to_string(),
        }
    }

    fn list_tools(&self) -> Vec<ToolDefinition> {
        vec![
            ToolDefinition {
                name: "run_typescript".to_string(),
                description: "Execute TypeScript or JavaScript code and return the output. Use console.log() to produce output.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "The TypeScript or JavaScript code to execute"
                        }
                    },
                    "required": ["code"]
                }),
            },
            ToolDefinition {
                name: "read_file".to_string(),
                description: "Read the contents of a file at the given path.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The path to the file to read"
                        }
                    },
                    "required": ["path"]
                }),
            },
            ToolDefinition {
                name: "write_file".to_string(),
                description: "Write content to a file at the given path. Creates parent directories if needed.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The path to the file to write"
                        },
                        "content": {
                            "type": "string",
                            "description": "The content to write to the file"
                        }
                    },
                    "required": ["path", "content"]
                }),
            },
            ToolDefinition {
                name: "list".to_string(),
                description: "List files and directories at the given path.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The directory path to list (default: /)"
                        }
                    },
                    "required": []
                }),
            },
            ToolDefinition {
                name: "grep".to_string(),
                description: "Search for a pattern in files under the given path.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "The regex pattern to search for"
                        },
                        "path": {
                            "type": "string",
                            "description": "The directory path to search in (default: /)"
                        }
                    },
                    "required": ["pattern"]
                }),
            },
        ]
    }

    fn call_tool(&mut self, name: &str, arguments: serde_json::Value) -> ToolResult {
        use crate::bindings::mcp::ts_runtime::browser_fs;
        
        match name {
            "run_typescript" => {
                let code = arguments.get("code").and_then(|v| v.as_str()).unwrap_or("");
                if code.is_empty() {
                    return ToolResult::error("No code provided".to_string());
                }
                match self.eval_code(code) {
                    Ok(r) => ToolResult::text(r),
                    Err(e) => ToolResult::error(e),
                }
            }
            "read_file" => {
                let path = arguments.get("path").and_then(|v| v.as_str()).unwrap_or("");
                if path.is_empty() {
                    return ToolResult::error("No path provided".to_string());
                }
                let result_json = browser_fs::read_file(path);
                // Parse the result and return appropriately
                match serde_json::from_str::<serde_json::Value>(&result_json) {
                    Ok(result) => {
                        if result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                            let content = result.get("content").and_then(|v| v.as_str()).unwrap_or("");
                            ToolResult::text(content.to_string())
                        } else {
                            let error = result.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
                            ToolResult::error(error.to_string())
                        }
                    }
                    Err(e) => ToolResult::error(format!("Failed to parse result: {}", e)),
                }
            }
            "write_file" => {
                let path = arguments.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let content = arguments.get("content").and_then(|v| v.as_str()).unwrap_or("");
                if path.is_empty() {
                    return ToolResult::error("No path provided".to_string());
                }
                let result_json = browser_fs::write_file(path, content);
                match serde_json::from_str::<serde_json::Value>(&result_json) {
                    Ok(result) => {
                        if result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                            ToolResult::text(format!("File written: {}", path))
                        } else {
                            let error = result.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
                            ToolResult::error(error.to_string())
                        }
                    }
                    Err(e) => ToolResult::error(format!("Failed to parse result: {}", e)),
                }
            }
            "list" => {
                let path = arguments.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                let result_json = browser_fs::list_dir(path);
                match serde_json::from_str::<serde_json::Value>(&result_json) {
                    Ok(result) => {
                        if result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                            let entries = result.get("entries")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter()
                                    .filter_map(|v| v.as_str())
                                    .collect::<Vec<_>>()
                                    .join("\n"))
                                .unwrap_or_default();
                            if entries.is_empty() {
                                ToolResult::text("(empty directory)".to_string())
                            } else {
                                ToolResult::text(entries)
                            }
                        } else {
                            let error = result.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
                            ToolResult::error(error.to_string())
                        }
                    }
                    Err(e) => ToolResult::error(format!("Failed to parse result: {}", e)),
                }
            }
            "grep" => {
                let pattern = arguments.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
                let path = arguments.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                if pattern.is_empty() {
                    return ToolResult::error("No pattern provided".to_string());
                }
                let result_json = browser_fs::grep(pattern, path);
                match serde_json::from_str::<serde_json::Value>(&result_json) {
                    Ok(result) => {
                        if result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                            let matches = result.get("matches")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter()
                                    .filter_map(|m| {
                                        let file = m.get("file")?.as_str()?;
                                        let line = m.get("line")?.as_u64()?;
                                        let text = m.get("text")?.as_str()?;
                                        Some(format!("{}:{}: {}", file, line, text))
                                    })
                                    .collect::<Vec<_>>()
                                    .join("\n"))
                                .unwrap_or_default();
                            if matches.is_empty() {
                                ToolResult::text("No matches found".to_string())
                            } else {
                                ToolResult::text(matches)
                            }
                        } else {
                            let error = result.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
                            ToolResult::error(error.to_string())
                        }
                    }
                    Err(e) => ToolResult::error(format!("Failed to parse result: {}", e)),
                }
            }
            _ => ToolResult::error(format!("Unknown tool: {}", name)),
        }
    }
}

/// Get or create the MCP server instance (thread-local)
fn with_server<F, R>(f: F) -> R
where
    F: FnOnce(&mut TsRuntimeMcp) -> R,
{
    MCP_SERVER.with(|server| {
        let mut server_ref = server.borrow_mut();
        if server_ref.is_none() {
            *server_ref = Some(TsRuntimeMcp::new().expect("Failed to create MCP server"));
        }
        f(server_ref.as_mut().unwrap())
    })
}

/// Handle JSON-RPC request
fn handle_mcp_request(request_str: &str) -> String {
    match serde_json::from_str::<JsonRpcRequest>(request_str) {
        Ok(req) => with_server(|server| {
            let response = mcp_server::handle_request(server, req);
            serde_json::to_string(&response)
                .unwrap_or_else(|_| r#"{"error":"serialize failed"}"#.to_string())
        }),
        Err(e) => {
            let err = JsonRpcResponse::error(None, -32700, format!("Parse error: {}", e));
            serde_json::to_string(&err)
                .unwrap_or_else(|_| r#"{"error":"serialize failed"}"#.to_string())
        }
    }
}

/// HTTP Component
struct Component;

bindings::export!(Component with_types_in bindings);

impl Guest for Component {
    fn handle(request: IncomingRequest, outparam: ResponseOutparam) {
        // Get request headers and path
        let headers = request.headers();
        let path = request.path_with_query().unwrap_or_default();

        // Read request body
        let body = request.consume().expect("consume body");
        let stream = body.stream().expect("get stream");

        let mut request_bytes = Vec::new();
        loop {
            match stream.blocking_read(65536) {
                Ok(bytes) if bytes.is_empty() => break,
                Ok(bytes) => request_bytes.extend(bytes),
                Err(_) => break,
            }
        }
        drop(stream);
        bindings::wasi::http::types::IncomingBody::finish(body);

        // Check for SSE support in Accept header
        let accept_sse = headers.entries().iter().any(|(k, v)| {
            k.to_lowercase() == "accept" && String::from_utf8_lossy(v).contains("text/event-stream")
        });

        // Simple endpoint routing
        let response_body = if path.starts_with("/sse") && accept_sse {
            // SSE endpoint - establish connection
            handle_sse_connection(&request_bytes)
        } else {
            // JSON-RPC endpoint
            let request_str = String::from_utf8_lossy(&request_bytes);
            handle_mcp_request(&request_str)
        };

        // Prepare response headers
        let hdrs = Fields::new();

        if accept_sse && path.starts_with("/sse") {
            hdrs.set(
                &"content-type".to_string(),
                &[b"text/event-stream".to_vec()],
            )
            .ok();
            hdrs.set(&"cache-control".to_string(), &[b"no-cache".to_vec()])
                .ok();
            hdrs.set(&"connection".to_string(), &[b"keep-alive".to_vec()])
                .ok();
        } else {
            hdrs.set(&"content-type".to_string(), &[b"application/json".to_vec()])
                .ok();
        }

        hdrs.set(&"access-control-allow-origin".to_string(), &[b"*".to_vec()])
            .ok();

        // Send response
        let resp = OutgoingResponse::new(hdrs);
        resp.set_status_code(200).ok();

        let body = resp.body().expect("response body");
        ResponseOutparam::set(outparam, Ok(resp));

        let out = body.write().expect("write stream");
        out.blocking_write_and_flush(response_body.as_bytes())
            .expect("write");
        drop(out);
        OutgoingBody::finish(body, None).unwrap();
    }
}

/// Handle SSE connection for MCP streaming protocol
fn handle_sse_connection(_request_bytes: &[u8]) -> String {
    // For SSE, we send events in the format:
    // event: message\ndata: {...}\n\n

    // Send initialization event
    let init_event = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });

    format!("event: message\ndata: {}\n\n", init_event)
}

// WASI component entry point - no main needed, export handles it
fn main() {
    // Component exports handle the actual entry point
}
