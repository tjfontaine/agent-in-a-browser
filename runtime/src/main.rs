//! MCP HTTP Server
//!
//! Implements wasi:http/incoming-handler to serve MCP protocol over HTTP.
//! Uses cargo-component bindings for WASI interfaces.

mod bindings;
mod host_bindings;
mod http_client;
mod loader;
mod mcp_server;
mod resolver;
mod shell;
mod transpiler;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{
    Fields, IncomingRequest, OutgoingBody, OutgoingResponse, ResponseOutparam,
};
use mcp_server::{JsonRpcRequest, JsonRpcResponse, ToolResult};
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt};
use runtime_macros::mcp_tool_router;
use serde_json::json;
use std::cell::RefCell;

/// The TypeScript Runtime MCP Server (thread-local, single-threaded)
struct TsRuntimeMcp {
    #[allow(dead_code)] // held to keep runtime alive
    runtime: AsyncRuntime,
    context: AsyncContext,
}

thread_local! {
    static MCP_SERVER: RefCell<Option<TsRuntimeMcp>> = RefCell::new(None);
    // Separate runtime for tsx shell command execution to avoid RefCell borrow conflicts
    // (shell commands run within MCP_SERVER borrow, so tsx can't re-borrow)
    static TSX_RUNTIME: RefCell<Option<TsRuntimeMcp>> = RefCell::new(None);
}

#[mcp_tool_router]
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

    #[allow(dead_code)] // convenience wrapper for eval_code_with_source
    fn eval_code(&mut self, code: &str) -> Result<String, String> {
        self.eval_code_with_source(code, "<eval>")
    }
    
    fn eval_code_with_source(&mut self, code: &str, source_name: &str) -> Result<String, String> {
        host_bindings::clear_logs();

        // Always transpile to handle TypeScript
        let js_code = transpiler::transpile(code)?;

        // Detect if code has ES module imports
        let has_imports = js_code.contains("import ") || js_code.contains("import{") 
            || js_code.contains("import\t") || js_code.contains("import\n");

        if has_imports {
            // Use Module::evaluate for ESM import support
            futures_lite::future::block_on(self.context.with(|ctx| {
                let result = rquickjs::Module::evaluate(ctx.clone(), source_name, js_code);
                match result.catch(&ctx) {
                    Ok(promise) => {
                        // Wait for module to finish evaluating
                        match promise.finish::<rquickjs::Value>() {
                            Ok(_) => {
                                let logs = host_bindings::get_logs();
                                if logs.is_empty() {
                                    Ok("(module executed)".to_string())
                                } else {
                                    Ok(logs)
                                }
                            }
                            Err(e) => {
                                // Try to extract exception details using ctx.catch()
                                Err(Self::format_js_error(&ctx, e, "Module error"))
                            }
                        }
                    }
                    Err(e) => {
                        // CaughtError contains the exception - format it
                        Err(format!("Module compile error: {}", e))
                    }
                }
            }))
        } else {
            // Script mode for simple code without imports
            let wrapped = format!("(async () => {{\n{}\n}})();", js_code);

            futures_lite::future::block_on(self.context.with(|ctx| {
                let result = ctx.eval::<rquickjs::Value, _>(wrapped.as_bytes());
                match result.catch(&ctx) {
                    Ok(val) => {
                        // Check if result is a Promise and resolve it
                        let resolved_val = if let Ok(promise) = rquickjs::Promise::from_value(val.clone()) {
                            // Drive the JS job queue until the Promise resolves
                            match promise.finish::<rquickjs::Value>() {
                                Ok(resolved) => resolved,
                                Err(e) => {
                                    // Promise rejected or error - return error message
                                    return Err(format!("Promise error: {:?}", e));
                                }
                            }
                        } else {
                            val
                        };
                        
                        // Format the resolved value
                        Self::format_value(&ctx, resolved_val)
                    }
                    Err(e) => Err(format!("Evaluation error: {:?}", e)),
                }
            }))
        }
    }
    
    /// Format a JavaScript error, extracting exception details if available
    fn format_js_error<'a>(ctx: &rquickjs::Ctx<'a>, err: rquickjs::Error, prefix: &str) -> String {
        // Check if there's a caught exception on the context
        // ctx.catch() returns Value which may be undefined if no exception
        let exc = ctx.catch();
        if !exc.is_undefined() {
            // Try to extract error message and stack
            if let Some(obj) = exc.as_object() {
                let mut parts = vec![];
                
                // Get error name (e.g., "TypeError", "SyntaxError")
                if let Ok(name) = obj.get::<_, String>("name") {
                    parts.push(name);
                }
                
                // Get error message
                if let Ok(msg) = obj.get::<_, String>("message") {
                    parts.push(msg);
                }
                
                // Get stack trace
                if let Ok(stack) = obj.get::<_, String>("stack") {
                    if !stack.is_empty() {
                        return format!("{}: {}\nStack: {}", prefix, parts.join(": "), stack);
                    }
                }
                
                if !parts.is_empty() {
                    return format!("{}: {}", prefix, parts.join(": "));
                }
            }
            
            // Fallback: try to stringify the exception
            if let Some(s) = exc.as_string() {
                if let Ok(msg) = s.to_string() {
                    return format!("{}: {}", prefix, msg);
                }
            }
            
            return format!("{}: {:?}", prefix, exc);
        }
        
        // No caught exception, use error's Display
        let error_msg = format!("{}", err);
        if error_msg.is_empty() || error_msg == "Exception" {
            format!("{}: {:?}", prefix, err)
        } else {
            format!("{}: {}", prefix, error_msg)
        }
    }
    
    /// Format a JavaScript value as a string for output
    fn format_value<'a>(ctx: &rquickjs::Ctx<'a>, val: rquickjs::Value<'a>) -> Result<String, String> {
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

    // Internal helpers - may be used for non-browser-fs implementations in the future
    #[allow(dead_code)]
    fn transpile_code(&self, code: &str) -> Result<String, String> {
        transpiler::transpile(code)
    }

    #[allow(dead_code)]
    fn read_file_internal(&self, path: &str) -> Result<String, String> {
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {}", path, e))
    }

    #[allow(dead_code)]
    fn write_file_internal(&self, path: &str, content: &str) -> Result<(), String> {
        std::fs::write(path, content).map_err(|e| format!("Failed to write {}: {}", path, e))
    }

    #[allow(dead_code)]
    fn list_dir_internal(&self, path: &str) -> Result<Vec<String>, String> {
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

    #[mcp_tool(description = "Execute shell commands with pipe support. Supports: echo, pwd, ls, cat, head, yes, true, false. Example: 'ls /data | head -n 5'")]
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

/// Public API for shell commands to execute JavaScript/TypeScript code.
/// Uses a separate QuickJS runtime (TSX_RUNTIME) to avoid RefCell conflicts
/// since shell commands run within an MCP_SERVER borrow.
pub fn eval_js(code: &str) -> Result<String, String> {
    eval_js_with_source(code, "<eval>")
}

/// Execute JavaScript/TypeScript code with a source path for module resolution.
/// The source_name is used as the base path when resolving relative imports.
pub fn eval_js_with_source(code: &str, source_name: &str) -> Result<String, String> {
    TSX_RUNTIME.with(|rt| {
        let mut rt_ref = rt.borrow_mut();
        if rt_ref.is_none() {
            *rt_ref = Some(TsRuntimeMcp::new().map_err(|e| format!("Failed to create tsx runtime: {}", e))?);
        }
        rt_ref.as_mut().unwrap().eval_code_with_source(code, source_name)
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
