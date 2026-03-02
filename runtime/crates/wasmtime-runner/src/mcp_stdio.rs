//! MCP stdio mode — headless JSON-RPC server over stdin/stdout.
//!
//! Reads MCP JSON-RPC requests from stdin (newline-delimited JSON),
//! routes them through the MCP WASM component's `wasi:http/incoming-handler`,
//! and writes responses to stdout.
//!
//! This enables `wasmtime-runner --mcp-stdio` as a fully native MCP server
//! with no browser or network required.

use anyhow::Result;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use serde_json::Value;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::bindings::http::types::Scheme;
use wasmtime_wasi_http::bindings::ProxyPre;
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

use crate::module_loader::ModuleLoader;

/// Host state for the MCP WASM component (separate from TUI's HostState
/// to avoid needing terminal_size and other TUI-specific Host traits).
pub struct McpHostState {
    wasi: WasiCtx,
    http: WasiHttpCtx,
    table: ResourceTable,
    pub module_loader: ModuleLoader,
}

impl WasiView for McpHostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for McpHostState {
    fn ctx(&mut self) -> &mut WasiHttpCtx {
        &mut self.http
    }
    fn table(&mut self) -> &mut ResourceTable {
        &mut self.table
    }
}

// Implement the module-loader Host trait for McpHostState
// (same implementation as TUI's HostState but on this type)
impl crate::bindings::ModuleLoaderHost for McpHostState {
    fn get_lazy_module(&mut self, _command: String) -> Option<String> {
        // In the MCP test harness, always return None so commands fall through
        // to built-in implementations. The lazy module system is for browser/native
        // environments where separate WASM modules handle certain commands (sqlite3, etc.).
        None
    }

    fn spawn_lazy_command(
        &mut self,
        module: String,
        command: String,
        args: Vec<String>,
        env: crate::bindings::LoaderExecEnv,
    ) -> wasmtime::component::Resource<crate::bindings::LazyProcess> {
        let _id = self
            .module_loader
            .spawn_lazy_command(&module, &command, args, env.cwd, env.vars);
        wasmtime::component::Resource::new_own(0)
    }

    fn spawn_interactive(
        &mut self,
        module: String,
        command: String,
        args: Vec<String>,
        env: crate::bindings::LoaderExecEnv,
        _size: crate::bindings::TerminalSize,
    ) -> wasmtime::component::Resource<crate::bindings::LazyProcess> {
        let _id = self
            .module_loader
            .spawn_lazy_command(&module, &command, args, env.cwd, env.vars);
        wasmtime::component::Resource::new_own(0)
    }

    fn is_interactive_command(&mut self, command: String) -> bool {
        self.module_loader.is_interactive_command(&command)
    }

    fn has_jspi(&mut self) -> bool {
        false
    }

    fn spawn_worker_command(
        &mut self,
        command: String,
        args: Vec<String>,
        env: crate::bindings::LoaderExecEnv,
    ) -> wasmtime::component::Resource<crate::bindings::LazyProcess> {
        if let Some(module) = self.module_loader.get_lazy_module(&command) {
            let _id = self
                .module_loader
                .spawn_lazy_command(&module, &command, args, env.cwd, env.vars);
        }
        wasmtime::component::Resource::new_own(0)
    }
}

// LazyProcess resource stubs for MCP mode
impl crate::bindings::HostLazyProcess for McpHostState {
    fn get_ready_pollable(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
    ) -> wasmtime::component::Resource<wasmtime_wasi::p2::bindings::io::poll::Pollable> {
        wasmtime::component::Resource::new_own(0)
    }
    fn is_ready(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
    ) -> bool {
        false
    }
    fn write_stdin(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
        _data: Vec<u8>,
    ) -> u64 {
        0
    }
    fn close_stdin(&mut self, _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>) {
    }
    fn read_stdout(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
        _max_bytes: u64,
    ) -> Vec<u8> {
        vec![]
    }
    fn read_stderr(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
        _max_bytes: u64,
    ) -> Vec<u8> {
        vec![]
    }
    fn try_wait(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
    ) -> Option<i32> {
        None
    }
    fn get_terminal_size(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
    ) -> crate::bindings::TerminalSize {
        crate::bindings::TerminalSize { cols: 80, rows: 24 }
    }
    fn set_terminal_size(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
        _size: crate::bindings::TerminalSize,
    ) {
    }
    fn set_raw_mode(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
        _enabled: bool,
    ) {
    }
    fn is_raw_mode(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
    ) -> bool {
        false
    }
    fn send_signal(
        &mut self,
        _self_: wasmtime::component::Resource<crate::bindings::LazyProcess>,
        _signum: u8,
    ) {
    }
    fn drop(
        &mut self,
        _rep: wasmtime::component::Resource<crate::bindings::LazyProcess>,
    ) -> wasmtime::Result<()> {
        Ok(())
    }
}

/// Create the Linker and ProxyPre for MCP component invocation.
///
/// This is the expensive setup step. The returned `ProxyPre` can be
/// reused across many `call_mcp_component` invocations.
pub fn setup_mcp_proxy(engine: &Engine, mcp_bytes: &[u8]) -> Result<ProxyPre<McpHostState>> {
    let mcp_component = Component::new(engine, mcp_bytes)?;

    let mut linker: Linker<McpHostState> = Linker::new(engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi_http::add_only_http_to_linker_async(&mut linker)?;

    use wasmtime::component::HasSelf;
    crate::bindings::add_module_loader_to_linker::<_, HasSelf<_>>(&mut linker, |s| s)?;

    let instance_pre = linker.instantiate_pre(&mcp_component)?;
    let proxy_pre = ProxyPre::new(instance_pre)?;
    Ok(proxy_pre)
}

/// Run the MCP stdio server loop.
///
/// Instantiates the MCP WASM component and processes JSON-RPC requests
/// from stdin, routing them through the component's `wasi:http/incoming-handler`.
pub async fn run_mcp_stdio(engine: &Engine, mcp_bytes: &[u8], work_dir: PathBuf) -> Result<()> {
    let proxy_pre = setup_mcp_proxy(engine, mcp_bytes)?;

    log("MCP stdio server ready");

    // Read JSON-RPC from stdin, one line per request
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut stdout = tokio::io::stdout();
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).await?;

        if bytes_read == 0 {
            // EOF — stdin closed
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Validate it's JSON before sending to WASM
        let json: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                let error_response = serde_json::json!({
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32700,
                        "message": format!("Parse error: {}", e)
                    },
                    "id": null
                });
                let mut out = serde_json::to_string(&error_response)?;
                out.push('\n');
                stdout.write_all(out.as_bytes()).await?;
                stdout.flush().await?;
                continue;
            }
        };

        // Check for notifications (no id = no response expected)
        let is_notification = json.get("id").is_none();
        let method = json
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();

        log(&format!("→ {}", method));

        // Route the request through the WASM component
        match call_mcp_component(engine, &proxy_pre, trimmed, &work_dir).await {
            Ok(response) => {
                if !is_notification && !response.is_empty() {
                    let mut out = response;
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                    stdout.write_all(out.as_bytes()).await?;
                    stdout.flush().await?;
                }
            }
            Err(e) => {
                log(&format!("Error processing {}: {}", method, e));
                if !is_notification {
                    let id = json.get("id").cloned().unwrap_or(Value::Null);
                    let error_response = serde_json::json!({
                        "jsonrpc": "2.0",
                        "error": {
                            "code": -32603,
                            "message": format!("Internal error: {}", e)
                        },
                        "id": id
                    });
                    let mut out = serde_json::to_string(&error_response)?;
                    out.push('\n');
                    stdout.write_all(out.as_bytes()).await?;
                    stdout.flush().await?;
                }
            }
        }
    }

    Ok(())
}

/// Send a single JSON-RPC request through the MCP WASM component.
///
/// Creates a fresh Store + instance for each request (clean state),
/// wraps the JSON body in an HTTP POST request, calls incoming-handler,
/// and reads the response body.
pub async fn call_mcp_component(
    engine: &Engine,
    proxy_pre: &ProxyPre<McpHostState>,
    json_body: &str,
    work_dir: &PathBuf,
) -> Result<String> {
    // Build WASI context with filesystem access to work_dir
    let wasi = WasiCtxBuilder::new()
        .inherit_stderr() // Logs go to stderr
        .inherit_env()
        .preopened_dir(
            work_dir,
            ".",
            wasmtime_wasi::DirPerms::all(),
            wasmtime_wasi::FilePerms::all(),
        )?
        .build();

    let state = McpHostState {
        wasi,
        http: WasiHttpCtx::new(),
        table: ResourceTable::new(),
        module_loader: ModuleLoader::new(work_dir.clone()),
    };

    let mut store = Store::new(engine, state);

    // Build the HTTP request wrapping the JSON-RPC body.
    // Map Full<Bytes> error type from Infallible to hyper::Error so it satisfies
    // the Into<ErrorCode> bound required by new_incoming_request.
    let body = Full::new(Bytes::from(json_body.to_string()))
        .map_err(|never| -> hyper::Error { match never {} });

    let hyper_request = hyper::Request::builder()
        .method(hyper::Method::POST)
        .uri("http://localhost/mcp")
        .header("content-type", "application/json")
        .body(body)
        .map_err(|e| anyhow::anyhow!("Failed to build HTTP request: {e}"))?;

    // Create a oneshot channel for the response.
    // The WASM component calls response-outparam::set() which sends through this channel.
    let (sender, receiver) = oneshot::channel();

    // Convert hyper request → WASI incoming-request resource
    let req = WasiHttpView::new_incoming_request(store.data_mut(), Scheme::Http, hyper_request)?;

    // Create the response-outparam resource
    let out = WasiHttpView::new_response_outparam(store.data_mut(), sender)?;

    // Instantiate the proxy and call the handler in a spawned task
    // (needed because call_handle takes ownership of store, and we need
    // to concurrently await the response channel)
    let proxy_pre = proxy_pre.clone();
    let task = tokio::task::spawn(async move {
        let proxy = proxy_pre.instantiate_async(&mut store).await?;
        proxy
            .wasi_http_incoming_handler()
            .call_handle(&mut store, req, out)
            .await?;
        Ok::<_, wasmtime::Error>(())
    });

    // Wait for the response from the oneshot channel
    let resp = match receiver.await {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => anyhow::bail!("MCP component returned error: {e:?}"),
        Err(_) => {
            // Channel dropped — check the task for the real error
            match task.await {
                Ok(Ok(())) => anyhow::bail!("MCP component never set response-outparam"),
                Ok(Err(e)) => anyhow::bail!("WASM execution error: {e}"),
                Err(e) => anyhow::bail!("Task panicked: {e}"),
            }
        }
    };

    // Collect the response body CONCURRENTLY with the WASM task.
    // The WASM component writes body chunks via blocking_write_and_flush,
    // which blocks until the host drains the output buffer. If we await
    // the task first, we deadlock — the task can't finish writing because
    // nobody is reading, and we can't read because we're waiting for the task.
    let (_parts, body) = resp.into_parts();
    let (body_result, task_result) = tokio::join!(body.collect(), task);

    // Check for errors
    if let Err(e) = task_result {
        anyhow::bail!("WASM task error: {e}");
    }

    let body_bytes = body_result
        .map_err(|e| anyhow::anyhow!("Failed to read response body: {e}"))?
        .to_bytes();
    let body_str = String::from_utf8(body_bytes.to_vec())
        .map_err(|e| anyhow::anyhow!("Response body not valid UTF-8: {e}"))?;

    Ok(body_str)
}

/// Log to stderr (stdout is reserved for JSON-RPC responses)
fn log(msg: &str) {
    eprintln!("[mcp-stdio] {}", msg);
}
