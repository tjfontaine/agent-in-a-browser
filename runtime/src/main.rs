//! MCP HTTP Server
//!
//! Implements wasi:http/incoming-handler to serve MCP protocol over HTTP.
//! Also implements shell:unix/command for interactive shell mode.
//! Pure shell-based implementation without JavaScript runtime.

mod bindings;
mod http_client;
mod mcp_server;
mod shell;

// Interactive shell module
mod interactive;

use bindings::exports::wasi::http::incoming_handler::Guest as HttpGuest;
use bindings::exports::shell::unix::command::Guest as CommandGuest;
use bindings::exports::shell::unix::command::ExecEnv;
use bindings::wasi::io::streams::{InputStream, OutputStream};
use bindings::wasi::http::types::{
    Fields, IncomingRequest, OutgoingBody, OutgoingResponse, ResponseOutparam,
};
use mcp_server::{JsonRpcRequest, JsonRpcResponse, ToolResult};
use runtime_macros::mcp_tool_router;
use serde_json::json;

/// The Shell-based MCP Server (stateless, created per-request)
/// Pure shell implementation - no JavaScript runtime
/// 
/// Note: This struct has no state - all state is created per-request in ShellEnv.
/// We create a new instance per request to avoid RefCell borrow conflicts in sync mode,
/// where WASI calls during shell execution can trigger re-entrant behavior.
struct ShellMcpServer;

#[mcp_tool_router]
impl ShellMcpServer {
    pub fn new() -> Result<Self, String> {
        Ok(Self)
    }

    // ============================================================
    // MCP Tools - these are auto-registered by #[mcp_tool_router]
    // ============================================================

    #[mcp_tool(description = "Read the contents of a file at the given path.")]
    fn read_file(&self, path: String) -> ToolResult {
        use std::fs;

        if path.is_empty() {
            return ToolResult::error("No path provided");
        }
        match fs::read_to_string(&path) {
            Ok(content) => ToolResult::text(content),
            Err(e) => ToolResult::error(format!("Failed to read {}: {}", path, e)),
        }
    }

    #[mcp_tool(description = "Write content to a file at the given path. Creates parent directories if needed.")]
    fn write_file(&self, path: String, content: String) -> ToolResult {
        use std::fs;
        use std::path::Path;

        if path.is_empty() {
            return ToolResult::error("No path provided");
        }

        // Create parent directories if needed
        if let Some(parent) = Path::new(&path).parent() {
            if !parent.as_os_str().is_empty() {
                if let Err(e) = fs::create_dir_all(parent) {
                    return ToolResult::error(format!("Failed to create directories: {}", e));
                }
            }
        }

        match fs::write(&path, &content) {
            Ok(()) => ToolResult::text(format!("File written: {}", path)),
            Err(e) => ToolResult::error(format!("Failed to write {}: {}", path, e)),
        }
    }

    #[mcp_tool(description = "List files and directories at the given path.")]
    fn list(&self, path: Option<String>) -> ToolResult {
        use std::fs;

        let path = path.as_deref().unwrap_or("/");

        match fs::read_dir(path) {
            Ok(entries) => {
                let mut names: Vec<String> = Vec::new();
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        names.push(format!("{}/", name));
                    } else {
                        names.push(name);
                    }
                }
                names.sort();
                if names.is_empty() {
                    ToolResult::text("(empty directory)")
                } else {
                    ToolResult::text(names.join("\n"))
                }
            }
            Err(e) => ToolResult::error(format!("Failed to list {}: {}", path, e)),
        }
    }

    #[mcp_tool(description = "Search for a pattern in files under the given path.")]
    fn grep(&self, pattern: String, path: Option<String>) -> ToolResult {
        use std::fs;

        if pattern.is_empty() {
            return ToolResult::error("No pattern provided");
        }

        let search_path = path.as_deref().unwrap_or("/");
        let mut matches: Vec<String> = Vec::new();

        // Recursive grep implementation
        fn search_directory(
            dir_path: &str,
            pattern: &str,
            matches: &mut Vec<String>,
        ) -> Result<(), std::io::Error> {
            for entry in fs::read_dir(dir_path)? {
                let entry = entry?;
                let path = entry.path();
                let path_str = path.to_string_lossy().to_string();

                if entry.file_type()?.is_dir() {
                    // Recurse into directory
                    let _ = search_directory(&path_str, pattern, matches);
                } else if entry.file_type()?.is_file() {
                    // Search file content
                    if let Ok(content) = fs::read_to_string(&path) {
                        for (line_num, line) in content.lines().enumerate() {
                            if line.to_lowercase().contains(&pattern.to_lowercase()) {
                                let trimmed = if line.len() > 100 {
                                    format!("{}...", &line[..100])
                                } else {
                                    line.to_string()
                                };
                                matches.push(format!("{}:{}: {}", path_str, line_num + 1, trimmed.trim()));
                            }
                        }
                    }
                }
            }
            Ok(())
        }

        if let Err(e) = search_directory(search_path, &pattern, &mut matches) {
            return ToolResult::error(format!("Grep failed: {}", e));
        }

        if matches.is_empty() {
            ToolResult::text("No matches found")
        } else {
            ToolResult::text(matches.join("\n"))
        }
    }

    #[mcp_tool(description = "Execute shell commands with pipe support. Supports 50+ commands including: echo, ls, cat, grep, sed, awk, jq, curl, sqlite3, tsx, tar, gzip, and more. Example: 'ls /data | head -n 5'")]
    fn shell_eval(&self, command: String) -> ToolResult {
        if command.is_empty() {
            return ToolResult::error("No command provided");
        }

        let mut env = shell::ShellEnv::new();
        let result = futures_lite::future::block_on(shell::run_pipeline(&command, &mut env));

        if result.code == 0 {
            if result.stdout.is_empty() && result.stderr.is_empty() {
                ToolResult::text("(no output)")
            } else if result.stderr.is_empty() {
                ToolResult::text(result.stdout)
            } else {
                ToolResult::text(format!("{}\nstderr: {}", result.stdout, result.stderr))
            }
        } else {
            ToolResult::error(format!(
                "Exit code {}: {}{}\n",
                result.code,
                result.stderr,
                result.stdout
            ))
        }
    }

    #[mcp_tool(description = "Edit a file by replacing old_str with new_str. The old_str must match exactly and uniquely in the file. For multiple edits, call this tool multiple times. Use read_file first to see the current content.")]
    fn edit_file(&self, path: String, old_str: String, new_str: String) -> ToolResult {
        use std::fs;

        if path.is_empty() {
            return ToolResult::error("No path provided");
        }
        if old_str.is_empty() {
            return ToolResult::error("old_str cannot be empty (use write_file for creating new files)");
        }

        // Read the current file content
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => return ToolResult::error(format!("Failed to read {}: {}", path, e)),
        };

        // Count occurrences of old_str
        let count = content.matches(&old_str).count();
        
        if count == 0 {
            // Provide helpful context about what's in the file
            let preview_lines: Vec<&str> = content.lines().take(10).collect();
            let preview = preview_lines.join("\n");
            return ToolResult::error(format!(
                "old_str not found in file.\n\nFirst 10 lines of file:\n{}\n\nMake sure old_str matches exactly (including whitespace).",
                preview
            ));
        }
        
        if count > 1 {
            // Find line numbers where matches occur to help user be more specific
            let mut match_lines = Vec::new();
            for (line_num, line) in content.lines().enumerate() {
                if line.contains(&old_str) {
                    match_lines.push(format!("  Line {}: {}", line_num + 1, 
                        if line.len() > 60 { format!("{}...", &line[..60]) } else { line.to_string() }));
                }
            }
            return ToolResult::error(format!(
                "old_str found {} times. Include more context to make it unique.\n\nMatches at:\n{}",
                count,
                match_lines.join("\n")
            ));
        }

        // Perform the replacement (exactly one match)
        let new_content = content.replacen(&old_str, &new_str, 1);

        // Write the updated content
        match fs::write(&path, &new_content) {
            Ok(()) => {
                let old_lines = old_str.lines().count();
                let new_lines = new_str.lines().count();
                ToolResult::text(format!(
                    "Edited {}: replaced {} line(s) with {} line(s)",
                    path, old_lines, new_lines
                ))
            }
            Err(e) => ToolResult::error(format!("Failed to write {}: {}", path, e)),
        }
    }
}

/// Handle JSON-RPC request
/// 
/// Creates a fresh ShellMcpServer instance per request to avoid RefCell borrow
/// conflicts in sync mode (Safari). The server is stateless, so this is safe.
fn handle_mcp_request(request_str: &str) -> String {
    match serde_json::from_str::<JsonRpcRequest>(request_str) {
        Ok(req) => {
            let mut server = ShellMcpServer::new().expect("Failed to create MCP server");
            let response = mcp_server::handle_request(&mut server, req);
            serde_json::to_string(&response)
                .unwrap_or_else(|_| r#"{"error":"serialize failed"}"#.to_string())
        }
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

impl HttpGuest for Component {
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

/// Interactive shell implementation
impl CommandGuest for Component {
    fn run(
        name: String,
        args: Vec<String>,
        env: ExecEnv,
        stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) -> i32 {
        match name.as_str() {
            "sh" | "shell" | "bash" | "brush-shell" => {
                interactive::run_shell(args, env, stdin, stdout, stderr)
            }
            _ => {
                let msg = format!("Unknown command: {}\n", name);
                let _ = stderr.blocking_write_and_flush(msg.as_bytes());
                127
            }
        }
    }

    fn list_commands() -> Vec<String> {
        vec![
            "sh".to_string(),
            "shell".to_string(),
            "bash".to_string(),
            "brush-shell".to_string(),
        ]
    }
}
