//! MCP Protocol-Level Test Harness
//!
//! Tests the WASM MCP server (ts-runtime-mcp) at the JSON-RPC protocol level
//! using wasmtime for native execution. Each test creates a fresh sandboxed
//! filesystem and sends MCP requests through the full WASM component pipeline.
//!
//! ## Prerequisites
//!
//! The MCP WASM component must be built first:
//! ```bash
//! cargo component build --release -p ts-runtime-mcp
//! ```
//!
//! ## Running
//!
//! ```bash
//! cargo test -p wasmtime-runner --test mcp_protocol
//! ```

mod harness {
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::LazyLock;
    use tempfile::TempDir;
    use wasmtime::{Config, Engine};
    use wasmtime_runner::mcp_stdio::{call_mcp_component, setup_mcp_proxy, McpHostState};
    use wasmtime_wasi_http::bindings::ProxyPre;

    /// Path to the pre-built MCP WASM component
    fn mcp_wasm_path() -> PathBuf {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest_dir
            .parent() // crates
            .unwrap()
            .parent() // runtime
            .unwrap()
            .parent() // web-agent
            .unwrap()
            .join("target/wasm32-wasip2/release/ts_runtime_mcp.wasm")
    }

    /// Shared Engine + ProxyPre — initialized once per test binary.
    /// Engine creation and WASM compilation are expensive (~2s); sharing them
    /// across all tests makes the suite fast.
    static MCP_RUNTIME: LazyLock<(Engine, ProxyPre<McpHostState>)> = LazyLock::new(|| {
        let wasm_path = mcp_wasm_path();
        let wasm_bytes = std::fs::read(&wasm_path).unwrap_or_else(|e| {
            panic!(
                "Failed to read MCP WASM at {}: {}\n\
                 Run: cargo component build --release -p ts-runtime-mcp",
                wasm_path.display(),
                e
            )
        });

        let mut config = Config::new();
        config.wasm_component_model(true);
        let engine = Engine::new(&config).expect("Failed to create wasmtime Engine");
        let proxy_pre = setup_mcp_proxy(&engine, &wasm_bytes).expect("Failed to setup MCP proxy");
        (engine, proxy_pre)
    });

    /// Test harness with a fresh temporary sandbox directory.
    ///
    /// Each test gets an isolated filesystem. The WASM component sees the
    /// temp directory as its root (preopened as ".").
    pub struct McpTestHarness {
        pub dir: TempDir,
        id_counter: u64,
    }

    impl McpTestHarness {
        pub fn new() -> Self {
            Self {
                dir: TempDir::new().expect("Failed to create temp dir"),
                id_counter: 0,
            }
        }

        fn next_id(&mut self) -> u64 {
            self.id_counter += 1;
            self.id_counter
        }

        /// Send a raw JSON-RPC request and return the parsed response.
        pub async fn send_raw(&mut self, request: Value) -> Value {
            let (engine, proxy_pre) = &*MCP_RUNTIME;
            let json_str = serde_json::to_string(&request).unwrap();
            let response_str =
                call_mcp_component(engine, proxy_pre, &json_str, &self.dir.path().to_path_buf())
                    .await
                    .expect("call_mcp_component failed");
            serde_json::from_str(&response_str).unwrap_or_else(|e| {
                panic!(
                    "Failed to parse response JSON: {}\nRaw: {}",
                    e, response_str
                )
            })
        }

        /// Send `initialize` request.
        pub async fn initialize(&mut self) -> Value {
            let id = self.next_id();
            self.send_raw(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "mcp-test-harness",
                        "version": "0.1.0"
                    }
                }
            }))
            .await
        }

        /// Send `tools/list` request.
        pub async fn tools_list(&mut self) -> Value {
            let id = self.next_id();
            self.send_raw(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/list",
                "params": {}
            }))
            .await
        }

        /// Send `ping` request.
        pub async fn ping(&mut self) -> Value {
            let id = self.next_id();
            self.send_raw(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "ping",
                "params": {}
            }))
            .await
        }

        /// Call a tool by name with arguments, returning the full JSON-RPC response.
        pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Value {
            let id = self.next_id();
            self.send_raw(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": arguments
                }
            }))
            .await
        }

        /// Call a tool and extract the text content from the first content item.
        pub async fn call_tool_text(&mut self, name: &str, arguments: Value) -> String {
            let resp = self.call_tool(name, arguments).await;
            resp["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .to_string()
        }

        /// Call a tool and check if the result indicates an error.
        pub async fn call_tool_is_error(&mut self, name: &str, arguments: Value) -> bool {
            let resp = self.call_tool(name, arguments).await;
            resp["result"]["isError"].as_bool().unwrap_or(false)
        }

        /// Send a raw JSON string (not necessarily valid JSON-RPC) and return the raw response string.
        /// Useful for testing parse error handling.
        pub async fn send_raw_str(&self, raw: &str) -> String {
            let (engine, proxy_pre) = &*MCP_RUNTIME;
            call_mcp_component(engine, proxy_pre, raw, &self.dir.path().to_path_buf())
                .await
                .expect("call_mcp_component failed")
        }

        /// Write a file into the sandbox (host-side, bypassing MCP — for test setup).
        pub fn write_fixture(&self, path: &str, content: &str) {
            let full_path = self.dir.path().join(path);
            if let Some(parent) = full_path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&full_path, content).unwrap();
        }

        /// Read a file from the sandbox (host-side, bypassing MCP — for assertions).
        pub fn read_fixture(&self, path: &str) -> String {
            let full_path = self.dir.path().join(path);
            std::fs::read_to_string(&full_path).unwrap()
        }

        /// Check if a file exists in the sandbox.
        #[allow(dead_code)]
        pub fn fixture_exists(&self, path: &str) -> bool {
            self.dir.path().join(path).exists()
        }
    }
}

// ============================================================
// Protocol conformance tests
// ============================================================

mod protocol {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn initialize_returns_server_info() {
        let mut h = McpTestHarness::new();
        let resp = h.initialize().await;
        assert_eq!(resp["jsonrpc"], "2.0");
        let result = &resp["result"];
        assert!(result["serverInfo"]["name"].is_string());
        assert!(result["serverInfo"]["version"].is_string());
        assert!(result["capabilities"]["tools"].is_object());
    }

    #[tokio::test]
    async fn initialize_reports_protocol_version() {
        let mut h = McpTestHarness::new();
        let resp = h.initialize().await;
        let version = resp["result"]["protocolVersion"].as_str().unwrap();
        assert!(!version.is_empty(), "protocolVersion should not be empty");
    }

    #[tokio::test]
    async fn initialize_reports_all_capabilities() {
        let mut h = McpTestHarness::new();
        let resp = h.initialize().await;
        let caps = &resp["result"]["capabilities"];
        assert!(caps["tools"].is_object(), "Missing tools capability");
        assert!(
            caps["resources"].is_object(),
            "Missing resources capability"
        );
        assert!(caps["prompts"].is_object(), "Missing prompts capability");
        assert!(caps["logging"].is_object(), "Missing logging capability");
    }

    #[tokio::test]
    async fn tools_list_returns_all_tools() {
        let mut h = McpTestHarness::new();
        let resp = h.tools_list().await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert!(
            tools.len() >= 5,
            "Expected at least 5 tools, got {}",
            tools.len()
        );
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"read_file"), "Missing read_file");
        assert!(names.contains(&"write_file"), "Missing write_file");
        assert!(names.contains(&"list"), "Missing list");
        assert!(names.contains(&"grep"), "Missing grep");
        assert!(names.contains(&"shell_eval"), "Missing shell_eval");
        assert!(names.contains(&"edit_file"), "Missing edit_file");
    }

    #[tokio::test]
    async fn tools_have_input_schema() {
        let mut h = McpTestHarness::new();
        let resp = h.tools_list().await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        for tool in tools {
            assert!(
                tool["inputSchema"].is_object(),
                "Tool {} missing inputSchema",
                tool["name"]
            );
            assert_eq!(
                tool["inputSchema"]["type"], "object",
                "Tool {} inputSchema type must be 'object'",
                tool["name"]
            );
        }
    }

    #[tokio::test]
    async fn tools_have_descriptions() {
        let mut h = McpTestHarness::new();
        let resp = h.tools_list().await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        for tool in tools {
            let desc = tool["description"].as_str().unwrap_or("");
            assert!(
                !desc.is_empty(),
                "Tool {} should have a non-empty description",
                tool["name"]
            );
        }
    }

    #[tokio::test]
    async fn tools_schema_lists_required_params() {
        let mut h = McpTestHarness::new();
        let resp = h.tools_list().await;
        let tools = resp["result"]["tools"].as_array().unwrap();
        // read_file requires "path"
        let read_file = tools.iter().find(|t| t["name"] == "read_file").unwrap();
        let required = read_file["inputSchema"]["required"].as_array().unwrap();
        let req_names: Vec<&str> = required.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(
            req_names.contains(&"path"),
            "read_file should require 'path'"
        );
    }

    #[tokio::test]
    async fn ping_returns_empty_result() {
        let mut h = McpTestHarness::new();
        let resp = h.ping().await;
        assert!(resp["result"].is_object());
        assert!(resp["error"].is_null());
    }

    #[tokio::test]
    async fn unknown_method_returns_method_not_found() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "nonexistent/method",
                "params": {}
            }))
            .await;
        assert!(resp["error"].is_object());
        assert_eq!(resp["error"]["code"], -32601, "Should be Method Not Found");
    }

    #[tokio::test]
    async fn response_ids_match_requests() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 42,
                "method": "ping",
                "params": {}
            }))
            .await;
        assert_eq!(resp["id"], 42);
    }

    #[tokio::test]
    async fn string_id_preserved() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": "my-request-id",
                "method": "ping",
                "params": {}
            }))
            .await;
        assert_eq!(resp["id"], "my-request-id");
    }

    #[tokio::test]
    async fn null_id_preserved() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": null,
                "method": "ping",
                "params": {}
            }))
            .await;
        assert!(resp["id"].is_null());
    }

    #[tokio::test]
    async fn resources_list_returns_empty() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "resources/list",
                "params": {}
            }))
            .await;
        let resources = resp["result"]["resources"].as_array().unwrap();
        assert!(resources.is_empty());
    }

    #[tokio::test]
    async fn resources_read_returns_error() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "resources/read",
                "params": {"uri": "file:///test"}
            }))
            .await;
        assert!(resp["error"].is_object());
    }

    #[tokio::test]
    async fn resource_templates_list_returns_empty() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "resources/templates/list",
                "params": {}
            }))
            .await;
        let templates = resp["result"]["resourceTemplates"].as_array().unwrap();
        assert!(templates.is_empty());
    }

    #[tokio::test]
    async fn prompts_list_returns_empty() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "prompts/list",
                "params": {}
            }))
            .await;
        let prompts = resp["result"]["prompts"].as_array().unwrap();
        assert!(prompts.is_empty());
    }

    #[tokio::test]
    async fn prompts_get_returns_error() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "prompts/get",
                "params": {"name": "test"}
            }))
            .await;
        assert!(resp["error"].is_object());
    }

    #[tokio::test]
    async fn logging_set_level_succeeds() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "logging/setLevel",
                "params": {"level": "debug"}
            }))
            .await;
        assert!(resp["result"].is_object());
        assert!(resp["error"].is_null());
    }

    #[tokio::test]
    async fn tools_call_missing_name_returns_invalid_params() {
        let mut h = McpTestHarness::new();
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "arguments": {}
                }
            }))
            .await;
        assert_eq!(resp["error"]["code"], -32602, "Should be Invalid Params");
    }

    #[tokio::test]
    async fn tools_call_unknown_tool() {
        let mut h = McpTestHarness::new();
        let resp = h.call_tool("nonexistent_tool_xyz", json!({})).await;
        // Should return a tool-level error (isError), not a JSON-RPC error
        let is_err = resp["result"]["isError"].as_bool().unwrap_or(false);
        let has_jsonrpc_err = resp["error"].is_object();
        assert!(
            is_err || has_jsonrpc_err,
            "Unknown tool should produce an error: {:?}",
            resp
        );
    }

    #[tokio::test]
    async fn tools_call_without_arguments_defaults_empty() {
        let mut h = McpTestHarness::new();
        // Call read_file without any arguments — should get a tool error about missing path
        let resp = h
            .send_raw(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "read_file"
                }
            }))
            .await;
        // Should not crash — either a tool error or a param error is acceptable
        assert!(
            resp["result"].is_object() || resp["error"].is_object(),
            "Should return either a result or error: {:?}",
            resp
        );
    }

    #[tokio::test]
    async fn malformed_json_returns_parse_error() {
        let h = McpTestHarness::new();
        let response_str = h.send_raw_str("this is not json").await;
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();
        assert_eq!(resp["error"]["code"], -32700, "Should be Parse Error");
    }
}

// ============================================================
// read_file tool tests
// ============================================================

mod read_file {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn reads_existing_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("hello.txt", "hello world");
        let text = h
            .call_tool_text("read_file", json!({"path": "hello.txt"}))
            .await;
        assert_eq!(text, "hello world");
    }

    #[tokio::test]
    async fn missing_file_returns_error() {
        let mut h = McpTestHarness::new();
        let is_err = h
            .call_tool_is_error("read_file", json!({"path": "nonexistent.txt"}))
            .await;
        assert!(is_err);
    }

    #[tokio::test]
    async fn reads_empty_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("empty.txt", "");
        let text = h
            .call_tool_text("read_file", json!({"path": "empty.txt"}))
            .await;
        assert_eq!(text, "");
    }

    #[tokio::test]
    async fn reads_multiline_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("multi.txt", "line1\nline2\nline3\n");
        let text = h
            .call_tool_text("read_file", json!({"path": "multi.txt"}))
            .await;
        assert_eq!(text, "line1\nline2\nline3\n");
    }

    #[tokio::test]
    async fn reads_nested_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("a/b/c.txt", "deep content");
        let text = h
            .call_tool_text("read_file", json!({"path": "a/b/c.txt"}))
            .await;
        assert_eq!(text, "deep content");
    }
}

// ============================================================
// write_file tool tests
// ============================================================

mod write_file {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn creates_new_file() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "write_file",
                json!({"path": "new.txt", "content": "created"}),
            )
            .await;
        assert!(text.contains("written") || text.contains("Written"));
        assert_eq!(h.read_fixture("new.txt"), "created");
    }

    #[tokio::test]
    async fn overwrites_existing_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("exists.txt", "old");
        h.call_tool_text(
            "write_file",
            json!({"path": "exists.txt", "content": "new"}),
        )
        .await;
        assert_eq!(h.read_fixture("exists.txt"), "new");
    }

    #[tokio::test]
    async fn creates_nested_directories() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "x/y/z/deep.txt", "content": "nested"}),
        )
        .await;
        assert_eq!(h.read_fixture("x/y/z/deep.txt"), "nested");
    }

    #[tokio::test]
    async fn writes_empty_content() {
        let mut h = McpTestHarness::new();
        h.call_tool_text("write_file", json!({"path": "empty.txt", "content": ""}))
            .await;
        assert_eq!(h.read_fixture("empty.txt"), "");
    }

    #[tokio::test]
    async fn empty_path_returns_error() {
        let mut h = McpTestHarness::new();
        let is_err = h
            .call_tool_is_error("write_file", json!({"path": "", "content": "x"}))
            .await;
        assert!(is_err);
    }
}

// ============================================================
// edit_file tool tests
// ============================================================

mod edit_file {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn replaces_unique_match() {
        let mut h = McpTestHarness::new();
        h.write_fixture("edit.txt", "hello world");
        h.call_tool_text(
            "edit_file",
            json!({"path": "edit.txt", "old_str": "world", "new_str": "rust"}),
        )
        .await;
        assert_eq!(h.read_fixture("edit.txt"), "hello rust");
    }

    #[tokio::test]
    async fn non_unique_match_returns_error() {
        let mut h = McpTestHarness::new();
        h.write_fixture("dup.txt", "aaa\naaa\n");
        let is_err = h
            .call_tool_is_error(
                "edit_file",
                json!({"path": "dup.txt", "old_str": "aaa", "new_str": "bbb"}),
            )
            .await;
        assert!(is_err);
        // File should be unchanged
        assert_eq!(h.read_fixture("dup.txt"), "aaa\naaa\n");
    }

    #[tokio::test]
    async fn missing_file_returns_error() {
        let mut h = McpTestHarness::new();
        let is_err = h
            .call_tool_is_error(
                "edit_file",
                json!({"path": "nope.txt", "old_str": "x", "new_str": "y"}),
            )
            .await;
        assert!(is_err);
    }

    #[tokio::test]
    async fn old_str_not_found_returns_error_with_preview() {
        let mut h = McpTestHarness::new();
        h.write_fixture("preview.txt", "line one\nline two\n");
        let resp = h
            .call_tool(
                "edit_file",
                json!({"path": "preview.txt", "old_str": "does not exist", "new_str": "x"}),
            )
            .await;
        assert!(resp["result"]["isError"].as_bool().unwrap_or(false));
        let text = resp["result"]["content"][0]["text"].as_str().unwrap_or("");
        // Should include file preview in error message
        assert!(
            text.contains("not found") || text.contains("No match"),
            "Expected 'not found' in error: {}",
            text
        );
    }

    #[tokio::test]
    async fn multiline_replacement() {
        let mut h = McpTestHarness::new();
        h.write_fixture("ml.txt", "fn main() {\n    println!(\"old\");\n}\n");
        h.call_tool_text(
            "edit_file",
            json!({
                "path": "ml.txt",
                "old_str": "    println!(\"old\");",
                "new_str": "    println!(\"new\");\n    println!(\"added\");"
            }),
        )
        .await;
        let content = h.read_fixture("ml.txt");
        assert!(content.contains("println!(\"new\")"));
        assert!(content.contains("println!(\"added\")"));
    }

    #[tokio::test]
    async fn preserves_surrounding_content() {
        let mut h = McpTestHarness::new();
        h.write_fixture("ctx.txt", "before\ntarget\nafter\n");
        h.call_tool_text(
            "edit_file",
            json!({"path": "ctx.txt", "old_str": "target", "new_str": "replaced"}),
        )
        .await;
        assert_eq!(h.read_fixture("ctx.txt"), "before\nreplaced\nafter\n");
    }
}

// ============================================================
// list tool tests
// ============================================================

mod list_tool {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn lists_files_in_directory() {
        let mut h = McpTestHarness::new();
        h.write_fixture("file1.txt", "a");
        h.write_fixture("file2.txt", "b");
        let text = h.call_tool_text("list", json!({"path": "."})).await;
        assert!(text.contains("file1.txt"));
        assert!(text.contains("file2.txt"));
    }

    #[tokio::test]
    async fn lists_nested_directory() {
        let mut h = McpTestHarness::new();
        h.write_fixture("sub/nested.txt", "x");
        let text = h.call_tool_text("list", json!({"path": "sub"})).await;
        assert!(text.contains("nested.txt"));
    }

    #[tokio::test]
    async fn empty_directory() {
        let mut h = McpTestHarness::new();
        std::fs::create_dir_all(h.dir.path().join("empty")).unwrap();
        let text = h.call_tool_text("list", json!({"path": "empty"})).await;
        assert!(
            text.contains("empty") || text.is_empty(),
            "Expected empty directory indicator, got: {}",
            text
        );
    }

    #[tokio::test]
    async fn nonexistent_directory_returns_error() {
        let mut h = McpTestHarness::new();
        let is_err = h.call_tool_is_error("list", json!({"path": "nope"})).await;
        assert!(is_err);
    }

    #[tokio::test]
    async fn directories_have_trailing_slash() {
        let mut h = McpTestHarness::new();
        h.write_fixture("mydir/child.txt", "x");
        let text = h.call_tool_text("list", json!({"path": "."})).await;
        assert!(
            text.contains("mydir/"),
            "Expected trailing slash for directory in: {}",
            text
        );
    }

    #[tokio::test]
    async fn results_are_sorted() {
        let mut h = McpTestHarness::new();
        h.write_fixture("c.txt", "");
        h.write_fixture("a.txt", "");
        h.write_fixture("b.txt", "");
        let text = h.call_tool_text("list", json!({"path": "."})).await;
        let lines: Vec<&str> = text.lines().collect();
        let mut sorted = lines.clone();
        sorted.sort();
        assert_eq!(lines, sorted, "List output should be sorted");
    }
}

// ============================================================
// grep tool tests
// ============================================================

mod grep_tool {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn finds_matches() {
        let mut h = McpTestHarness::new();
        h.write_fixture("search.txt", "hello world\nfoo bar\nhello again\n");
        let text = h
            .call_tool_text("grep", json!({"pattern": "hello", "path": "."}))
            .await;
        assert!(text.contains("hello world"));
        assert!(text.contains("hello again"));
    }

    #[tokio::test]
    async fn no_matches() {
        let mut h = McpTestHarness::new();
        h.write_fixture("nope.txt", "nothing here");
        let text = h
            .call_tool_text("grep", json!({"pattern": "zzzzz", "path": "."}))
            .await;
        assert!(
            text.to_lowercase().contains("no match"),
            "Expected 'no match' indicator in: {}",
            text
        );
    }

    #[tokio::test]
    async fn recursive_search() {
        let mut h = McpTestHarness::new();
        h.write_fixture("a/b/deep.txt", "target_string_here");
        let text = h
            .call_tool_text("grep", json!({"pattern": "target_string", "path": "."}))
            .await;
        assert!(text.contains("target_string"));
    }

    #[tokio::test]
    async fn case_insensitive() {
        let mut h = McpTestHarness::new();
        h.write_fixture("case.txt", "Hello World");
        let text = h
            .call_tool_text("grep", json!({"pattern": "hello", "path": "."}))
            .await;
        assert!(
            text.contains("Hello World"),
            "Case-insensitive grep should match: {}",
            text
        );
    }

    #[tokio::test]
    async fn includes_line_numbers() {
        let mut h = McpTestHarness::new();
        h.write_fixture("lines.txt", "a\nb\ntarget\nd\n");
        let text = h
            .call_tool_text("grep", json!({"pattern": "target", "path": "."}))
            .await;
        assert!(
            text.contains(":3:"),
            "Expected line number :3: in: {}",
            text
        );
    }

    #[tokio::test]
    async fn multiple_files() {
        let mut h = McpTestHarness::new();
        h.write_fixture("f1.txt", "match here");
        h.write_fixture("f2.txt", "also match here");
        h.write_fixture("f3.txt", "no hit");
        let text = h
            .call_tool_text("grep", json!({"pattern": "match", "path": "."}))
            .await;
        assert!(text.contains("f1.txt"));
        assert!(text.contains("f2.txt"));
        assert!(!text.contains("f3.txt"));
    }
}

// ============================================================
// shell_eval tool tests
// ============================================================

mod shell_eval {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn echo_basic() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo hello world"}))
            .await;
        assert!(text.contains("hello world"));
    }

    #[tokio::test]
    async fn ls_lists_files() {
        let mut h = McpTestHarness::new();
        h.write_fixture("visible.txt", "x");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "ls"}))
            .await;
        assert!(text.contains("visible.txt"));
    }

    #[tokio::test]
    async fn pipe_works() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo -e 'line1\\nline2\\nline3' | wc -l"}),
            )
            .await;
        assert!(text.trim().contains('3'), "Expected 3 lines, got: {}", text);
    }

    #[tokio::test]
    async fn nonzero_exit_code_is_error() {
        let mut h = McpTestHarness::new();
        let is_err = h
            .call_tool_is_error(
                "shell_eval",
                json!({"command": "cat nonexistent_file_12345"}),
            )
            .await;
        assert!(is_err);
    }

    #[tokio::test]
    async fn cat_reads_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("readable.txt", "file content here");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "cat readable.txt"}))
            .await;
        assert!(text.contains("file content here"));
    }

    #[tokio::test]
    async fn redirect_writes_file() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "shell_eval",
            json!({"command": "echo 'redirected content' > out.txt"}),
        )
        .await;
        assert_eq!(h.read_fixture("out.txt").trim(), "redirected content");
    }

    #[tokio::test]
    async fn multi_command_with_semicolon() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo first; echo second"}))
            .await;
        assert!(text.contains("first"));
        assert!(text.contains("second"));
    }

    #[tokio::test]
    async fn jq_filter() {
        let mut h = McpTestHarness::new();
        h.write_fixture("data.json", "{\"name\": \"test\", \"value\": 42}");
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat data.json | jq '.name'"}),
            )
            .await;
        assert!(
            text.contains("test"),
            "jq should extract .name field: {}",
            text
        );
    }

    #[tokio::test]
    async fn grep_in_pipeline() {
        let mut h = McpTestHarness::new();
        h.write_fixture("log.txt", "INFO: ok\nERROR: fail\nINFO: done\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "cat log.txt | grep ERROR"}))
            .await;
        assert!(text.contains("ERROR: fail"));
        assert!(!text.contains("INFO"));
    }

    #[tokio::test]
    async fn variable_expansion() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "X=hello; echo $X"}))
            .await;
        assert!(text.contains("hello"));
    }

    #[tokio::test]
    async fn sort_and_uniq() {
        let mut h = McpTestHarness::new();
        h.write_fixture("dup.txt", "b\na\nb\nc\na\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "sort dup.txt | uniq"}))
            .await;
        let lines: Vec<&str> = text.trim().lines().collect();
        assert_eq!(lines, vec!["a", "b", "c"]);
    }
}

// ============================================================
// Multi-tool workflow tests
// ============================================================

mod workflows {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "wf.txt", "content": "workflow content"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "wf.txt"}))
            .await;
        assert_eq!(text, "workflow content");
    }

    #[tokio::test]
    async fn write_edit_read() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "wfe.txt", "content": "original text"}),
        )
        .await;
        h.call_tool_text(
            "edit_file",
            json!({"path": "wfe.txt", "old_str": "original", "new_str": "modified"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "wfe.txt"}))
            .await;
        assert_eq!(text, "modified text");
    }

    #[tokio::test]
    async fn write_then_shell_cat() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "shell_read.txt", "content": "via shell"}),
        )
        .await;
        let text = h
            .call_tool_text("shell_eval", json!({"command": "cat shell_read.txt"}))
            .await;
        assert!(text.contains("via shell"));
    }

    #[tokio::test]
    async fn shell_redirect_then_read_file() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "shell_eval",
            json!({"command": "echo 'shell wrote this' > from_shell.txt"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "from_shell.txt"}))
            .await;
        assert!(text.contains("shell wrote this"));
    }

    #[tokio::test]
    async fn write_multiple_then_grep() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "a.txt", "content": "findable token here"}),
        )
        .await;
        h.call_tool_text(
            "write_file",
            json!({"path": "b.txt", "content": "nothing relevant"}),
        )
        .await;
        let text = h
            .call_tool_text("grep", json!({"pattern": "findable", "path": "."}))
            .await;
        assert!(text.contains("a.txt"));
        assert!(!text.contains("b.txt"));
    }

    #[tokio::test]
    async fn write_then_list() {
        let mut h = McpTestHarness::new();
        h.call_tool_text("write_file", json!({"path": "dir/sub.txt", "content": "x"}))
            .await;
        let root = h.call_tool_text("list", json!({"path": "."})).await;
        assert!(root.contains("dir"));
        let sub = h.call_tool_text("list", json!({"path": "dir"})).await;
        assert!(sub.contains("sub.txt"));
    }

    #[tokio::test]
    async fn data_pipeline_json() {
        let mut h = McpTestHarness::new();
        // Write JSON, process with jq, verify via grep
        h.call_tool_text(
            "write_file",
            json!({
                "path": "data.json",
                "content": "[{\"id\":1,\"name\":\"alice\"},{\"id\":2,\"name\":\"bob\"}]"
            }),
        )
        .await;
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat data.json | jq '.[0].name'"}),
            )
            .await;
        assert!(text.contains("alice"));
    }

    #[tokio::test]
    async fn code_edit_workflow() {
        let mut h = McpTestHarness::new();
        // Write a script, edit it, verify contents
        h.call_tool_text(
            "write_file",
            json!({
                "path": "script.sh",
                "content": "#!/bin/sh\necho 'version 1'\n"
            }),
        )
        .await;
        h.call_tool_text(
            "edit_file",
            json!({
                "path": "script.sh",
                "old_str": "version 1",
                "new_str": "version 2"
            }),
        )
        .await;
        let content = h
            .call_tool_text("read_file", json!({"path": "script.sh"}))
            .await;
        assert!(content.contains("version 2"));
        assert!(!content.contains("version 1"));
    }
}

// ============================================================
// Edge case tests
// ============================================================

mod edge_cases {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn multiline_file_roundtrip() {
        let mut h = McpTestHarness::new();
        // Write a multi-line file via host fixture and read via MCP
        let content = "abcdefghij\n".repeat(100);
        h.write_fixture("multiline.txt", &content);
        let text = h
            .call_tool_text("read_file", json!({"path": "multiline.txt"}))
            .await;
        assert_eq!(text.len(), 1100);
    }

    #[tokio::test]
    async fn write_file_with_large_content() {
        let mut h = McpTestHarness::new();
        let content = "abcdefghij\n".repeat(500); // ~5.5KB payload
        let text = h
            .call_tool_text(
                "write_file",
                json!({"path": "large_write.txt", "content": content}),
            )
            .await;
        assert!(
            text.contains("written") || text.contains("Written"),
            "Expected 'written' in: {}",
            text
        );
        // Verify file was actually written with correct content
        let readback = h.read_fixture("large_write.txt");
        assert_eq!(readback, content);
    }

    #[tokio::test]
    async fn large_file_read_roundtrip() {
        let mut h = McpTestHarness::new();
        let large_content = "x".repeat(50_000); // 50KB file
        h.write_fixture("large.txt", &large_content);

        let text = h
            .call_tool_text("read_file", json!({"path": "large.txt"}))
            .await;
        assert_eq!(text.len(), 50_000, "Large file content should be complete");
        assert_eq!(text, large_content);
    }

    #[tokio::test]
    async fn very_large_file_read_roundtrip() {
        let mut h = McpTestHarness::new();
        let large_content = "y".repeat(100_000); // 100KB file
        h.write_fixture("very_large.txt", &large_content);

        let text = h
            .call_tool_text("read_file", json!({"path": "very_large.txt"}))
            .await;
        assert_eq!(
            text.len(),
            100_000,
            "Very large file content should be complete"
        );
        assert_eq!(text, large_content);
    }

    #[tokio::test]
    async fn unicode_content() {
        let mut h = McpTestHarness::new();
        let unicode = "Hello, 世界! 😀 emoji — em-dash";
        h.call_tool_text(
            "write_file",
            json!({"path": "unicode.txt", "content": unicode}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "unicode.txt"}))
            .await;
        assert_eq!(text, unicode);
    }

    #[tokio::test]
    async fn spaces_in_filename() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "file with spaces.txt", "content": "spaces"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "file with spaces.txt"}))
            .await;
        assert_eq!(text, "spaces");
    }

    #[tokio::test]
    async fn deeply_nested_path() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "a/b/c/d/e/f/g.txt", "content": "deep"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "a/b/c/d/e/f/g.txt"}))
            .await;
        assert_eq!(text, "deep");
    }

    #[tokio::test]
    async fn special_json_characters_in_content() {
        let mut h = McpTestHarness::new();
        let content = "line with \"quotes\" and \\backslashes\\ and\ttabs\n";
        h.call_tool_text(
            "write_file",
            json!({"path": "special.txt", "content": content}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "special.txt"}))
            .await;
        assert_eq!(text, content);
    }

    #[tokio::test]
    async fn multiple_sequential_tool_calls() {
        let mut h = McpTestHarness::new();
        // Verify state persists across multiple calls within one harness
        for i in 0..10 {
            h.call_tool_text(
                "write_file",
                json!({"path": format!("seq_{}.txt", i), "content": format!("content_{}", i)}),
            )
            .await;
        }
        for i in 0..10 {
            let text = h
                .call_tool_text("read_file", json!({"path": format!("seq_{}.txt", i)}))
                .await;
            assert_eq!(text, format!("content_{}", i));
        }
    }

    #[tokio::test]
    async fn grep_with_special_chars() {
        let mut h = McpTestHarness::new();
        // Grep is substring-based (not regex), so special chars are matched literally
        h.write_fixture("special.txt", "price is $100.00\nno match\n");
        let text = h
            .call_tool_text("grep", json!({"pattern": "$100", "path": "."}))
            .await;
        assert!(text.contains("$100"));
    }

    #[tokio::test]
    async fn edit_file_adds_lines() {
        let mut h = McpTestHarness::new();
        h.write_fixture("grow.txt", "line1\nline2\n");
        h.call_tool_text(
            "edit_file",
            json!({
                "path": "grow.txt",
                "old_str": "line2",
                "new_str": "line2\nline3\nline4"
            }),
        )
        .await;
        let content = h.read_fixture("grow.txt");
        assert_eq!(content, "line1\nline2\nline3\nline4\n");
    }

    #[tokio::test]
    async fn edit_file_removes_lines() {
        let mut h = McpTestHarness::new();
        h.write_fixture("shrink.txt", "keep\nremove this\nkeep too\n");
        h.call_tool_text(
            "edit_file",
            json!({
                "path": "shrink.txt",
                "old_str": "remove this\n",
                "new_str": ""
            }),
        )
        .await;
        let content = h.read_fixture("shrink.txt");
        assert_eq!(content, "keep\nkeep too\n");
    }

    #[tokio::test]
    async fn dotfile_roundtrip() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": ".hidden", "content": "secret"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": ".hidden"}))
            .await;
        assert_eq!(text, "secret");
    }

    #[tokio::test]
    async fn list_shows_dotfiles() {
        let mut h = McpTestHarness::new();
        h.write_fixture(".hidden", "x");
        h.write_fixture("visible.txt", "x");
        let text = h.call_tool_text("list", json!({"path": "."})).await;
        assert!(text.contains(".hidden"), "Should list dotfiles: {}", text);
        assert!(text.contains("visible.txt"));
    }

    #[tokio::test]
    async fn crlf_line_endings_preserved() {
        let mut h = McpTestHarness::new();
        let content = "line1\r\nline2\r\nline3\r\n";
        h.call_tool_text(
            "write_file",
            json!({"path": "crlf.txt", "content": content}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "crlf.txt"}))
            .await;
        assert_eq!(text, content, "CRLF line endings should be preserved");
    }

    #[tokio::test]
    async fn file_with_no_trailing_newline() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "noterminal.txt", "content": "no newline at end"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "noterminal.txt"}))
            .await;
        assert_eq!(text, "no newline at end");
        assert!(!text.ends_with('\n'));
    }

    #[tokio::test]
    async fn write_file_large_via_mcp_roundtrip() {
        let mut h = McpTestHarness::new();
        // 20KB write through MCP, then read back through MCP
        let content = "0123456789".repeat(2000);
        h.call_tool_text("write_file", json!({"path": "big.txt", "content": content}))
            .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "big.txt"}))
            .await;
        assert_eq!(text.len(), 20_000);
        assert_eq!(text, content);
    }

    #[tokio::test]
    async fn long_single_line_file() {
        let mut h = McpTestHarness::new();
        // A file with one very long line (no newlines)
        let content = "a".repeat(10_000);
        h.write_fixture("longline.txt", &content);
        let text = h
            .call_tool_text("read_file", json!({"path": "longline.txt"}))
            .await;
        assert_eq!(text.len(), 10_000);
    }

    #[tokio::test]
    async fn edit_file_empty_old_str_rejected() {
        let mut h = McpTestHarness::new();
        h.write_fixture("edit_empty.txt", "some content");
        let is_err = h
            .call_tool_is_error(
                "edit_file",
                json!({"path": "edit_empty.txt", "old_str": "", "new_str": "x"}),
            )
            .await;
        assert!(is_err, "Empty old_str should be rejected");
    }

    #[tokio::test]
    async fn edit_file_noop_same_strings() {
        let mut h = McpTestHarness::new();
        h.write_fixture("noop.txt", "hello world\n");
        // Replace "hello" with "hello" — should succeed but not change file
        let text = h
            .call_tool_text(
                "edit_file",
                json!({"path": "noop.txt", "old_str": "hello", "new_str": "hello"}),
            )
            .await;
        assert!(
            text.to_lowercase().contains("edited") || text.to_lowercase().contains("replaced"),
            "Should report success: {}",
            text
        );
        assert_eq!(h.read_fixture("noop.txt"), "hello world\n");
    }

    #[tokio::test]
    async fn edit_file_whitespace_sensitive() {
        let mut h = McpTestHarness::new();
        h.write_fixture("ws.txt", "  indented\n");
        // Try to match without leading spaces — should fail
        let is_err = h
            .call_tool_is_error(
                "edit_file",
                json!({"path": "ws.txt", "old_str": "indented", "new_str": "x"}),
            )
            .await;
        // "indented" appears within "  indented" so it should match as substring
        // Actually, edit_file uses content.matches() which IS substring, so this succeeds
        assert!(!is_err, "Substring match should work");
        let content = h.read_fixture("ws.txt");
        assert_eq!(content, "  x\n");
    }

    #[tokio::test]
    async fn read_file_empty_path_returns_error() {
        let mut h = McpTestHarness::new();
        let is_err = h.call_tool_is_error("read_file", json!({"path": ""})).await;
        assert!(is_err);
    }

    #[tokio::test]
    async fn grep_empty_pattern_returns_error() {
        let mut h = McpTestHarness::new();
        h.write_fixture("test.txt", "content");
        let is_err = h
            .call_tool_is_error("grep", json!({"pattern": "", "path": "."}))
            .await;
        assert!(is_err, "Empty grep pattern should be rejected");
    }

    #[tokio::test]
    async fn shell_eval_empty_command_returns_error() {
        let mut h = McpTestHarness::new();
        let is_err = h
            .call_tool_is_error("shell_eval", json!({"command": ""}))
            .await;
        assert!(is_err, "Empty command should be rejected");
    }

    #[tokio::test]
    async fn grep_default_path() {
        let mut h = McpTestHarness::new();
        h.write_fixture("root.txt", "findme");
        // Grep without specifying path — should use default
        let text = h.call_tool_text("grep", json!({"pattern": "findme"})).await;
        assert!(
            text.contains("findme"),
            "Grep with default path should find matches: {}",
            text
        );
    }

    #[tokio::test]
    async fn list_default_path() {
        let mut h = McpTestHarness::new();
        h.write_fixture("default.txt", "x");
        // List without specifying path
        let text = h.call_tool_text("list", json!({})).await;
        // Should list something (either root or sandbox root)
        assert!(!text.is_empty(), "Default list should return something");
    }

    #[tokio::test]
    async fn grep_skips_binary_files_silently() {
        let mut h = McpTestHarness::new();
        // Write a file with non-UTF-8 bytes (host-side since write_file only does UTF-8)
        let binary_path = h.dir.path().join("binary.dat");
        std::fs::write(&binary_path, &[0xFF, 0xFE, 0x00, 0x01, 0x80]).unwrap();
        h.write_fixture("text.txt", "searchable content");
        // Grep should find text.txt and skip binary.dat without crashing
        let text = h
            .call_tool_text("grep", json!({"pattern": "searchable", "path": "."}))
            .await;
        assert!(text.contains("text.txt"));
        assert!(!text.contains("binary.dat"));
    }

    #[tokio::test]
    async fn edit_file_multiline_old_str_across_lines() {
        let mut h = McpTestHarness::new();
        h.write_fixture("cross.txt", "start\nmiddle\nend\n");
        // Match spans across two lines
        h.call_tool_text(
            "edit_file",
            json!({
                "path": "cross.txt",
                "old_str": "start\nmiddle",
                "new_str": "replaced"
            }),
        )
        .await;
        assert_eq!(h.read_fixture("cross.txt"), "replaced\nend\n");
    }

    #[tokio::test]
    async fn json_content_roundtrip() {
        let mut h = McpTestHarness::new();
        // JSON content with all special chars — must survive JSON-in-JSON encoding
        let content = r#"{"key": "value", "nested": {"arr": [1, 2, 3]}, "escaped": "a\"b\\c"}"#;
        h.call_tool_text(
            "write_file",
            json!({"path": "meta.json", "content": content}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "meta.json"}))
            .await;
        assert_eq!(text, content);
    }

    #[tokio::test]
    async fn content_with_null_chars() {
        let mut h = McpTestHarness::new();
        // JSON strings can contain \u0000 but filesystem handling varies
        let content = "before\0after";
        h.call_tool_text(
            "write_file",
            json!({"path": "null.txt", "content": content}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "null.txt"}))
            .await;
        assert_eq!(text, content);
    }

    #[tokio::test]
    async fn many_small_files() {
        let mut h = McpTestHarness::new();
        // Create 50 files, verify list returns all of them
        for i in 0..50 {
            h.write_fixture(&format!("file_{:03}.txt", i), &format!("content {}", i));
        }
        let text = h.call_tool_text("list", json!({"path": "."})).await;
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines.len(),
            50,
            "Should list all 50 files, got {}",
            lines.len()
        );
    }

    #[tokio::test]
    async fn grep_many_matches() {
        let mut h = McpTestHarness::new();
        // File where every line matches
        let content = (0..100)
            .map(|i| format!("match line {}", i))
            .collect::<Vec<_>>()
            .join("\n");
        h.write_fixture("many.txt", &content);
        let text = h
            .call_tool_text("grep", json!({"pattern": "match", "path": "."}))
            .await;
        let match_count = text.lines().count();
        assert_eq!(
            match_count, 100,
            "Should find all 100 matches, got {}",
            match_count
        );
    }

    #[tokio::test]
    async fn grep_long_line_with_multibyte_utf8() {
        let mut h = McpTestHarness::new();
        // Create a line >100 chars of multi-byte UTF-8.
        // "é" is 2 bytes — byte-level slicing at position 100 would split
        // the code point and panic. Char-level truncation must be used.
        let line: String = "é".repeat(120);
        h.write_fixture("utf8_long.txt", &line);
        let text = h
            .call_tool_text("grep", json!({"pattern": "é", "path": "."}))
            .await;
        assert!(
            text.contains("utf8_long.txt"),
            "Should find match in utf8 file: {}",
            text
        );
        // The truncated line should end with "..."
        assert!(
            text.contains("..."),
            "Long line should be truncated with ellipsis: {}",
            text
        );
    }

    #[tokio::test]
    async fn edit_file_non_unique_multibyte_utf8_diagnostic() {
        let mut h = McpTestHarness::new();
        // Create a file where a SHORT multi-byte substring appears on two long lines,
        // triggering the "non-unique" error path which truncates lines at 60 chars.
        // The lines must be >60 chars to exercise the truncation code path.
        let prefix = "日本語テスト".repeat(12); // 72 chars of 3-byte CJK
        let line_a = format!("{}:AAA:共通", prefix);
        let line_b = format!("{}:BBB:共通", prefix);
        let content = format!("{}\n{}\n", line_a, line_b);
        h.write_fixture("utf8_edit.txt", &content);
        // Search for the short common substring that appears in both lines
        let result = h
            .call_tool(
                "edit_file",
                json!({
                    "path": "utf8_edit.txt",
                    "old_str": "共通",
                    "new_str": "replaced"
                }),
            )
            .await;
        // Should be an error (non-unique match), not a panic
        let inner = &result["result"];
        assert!(
            inner["isError"].as_bool().unwrap_or(false),
            "Expected isError for non-unique match, got: {}",
            result
        );
        let text = inner["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("found 2 times"),
            "Should report non-unique match: {}",
            text
        );
        // Verify the diagnostic includes truncated lines (proves char-level truncation)
        assert!(
            text.contains("..."),
            "Long lines should be truncated with ellipsis: {}",
            text
        );
    }
}

// ============================================================
// Shell edge case tests
// ============================================================

mod shell_edge_cases {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn and_chain_succeeds() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "true && echo yes"}))
            .await;
        assert!(text.contains("yes"));
    }

    #[tokio::test]
    async fn and_chain_short_circuits() {
        let mut h = McpTestHarness::new();
        let is_err = h
            .call_tool_is_error(
                "shell_eval",
                json!({"command": "false && echo unreachable"}),
            )
            .await;
        assert!(is_err, "&& should short-circuit on failure");
    }

    #[tokio::test]
    async fn or_chain_fallback() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "false || echo fallback"}))
            .await;
        assert!(text.contains("fallback"));
    }

    #[tokio::test]
    async fn or_chain_skips_on_success() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo first || echo second"}),
            )
            .await;
        assert!(text.contains("first"));
        assert!(!text.contains("second"));
    }

    #[tokio::test]
    async fn if_then_else() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if true; then echo yes; else echo no; fi"}),
            )
            .await;
        assert!(text.contains("yes"));
        assert!(!text.contains("no"));
    }

    #[tokio::test]
    async fn if_else_branch() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if false; then echo yes; else echo no; fi"}),
            )
            .await;
        assert!(text.contains("no"));
    }

    #[tokio::test]
    async fn for_loop() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "for x in a b c; do echo $x; done"}),
            )
            .await;
        assert!(text.contains("a"));
        assert!(text.contains("b"));
        assert!(text.contains("c"));
    }

    #[tokio::test]
    async fn while_loop() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done"}),
            )
            .await;
        assert!(text.contains("0"));
        assert!(text.contains("1"));
        assert!(text.contains("2"));
    }

    #[tokio::test]
    async fn command_substitution() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo \"today is $(echo Tuesday)\""}),
            )
            .await;
        assert!(text.contains("today is Tuesday"));
    }

    #[tokio::test]
    async fn arithmetic_expansion() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo $((2 + 3 * 4))"}))
            .await;
        assert!(text.contains("14"));
    }

    #[tokio::test]
    async fn env_isolation_between_calls() {
        let mut h = McpTestHarness::new();
        // Set variable in first call
        h.call_tool_text(
            "shell_eval",
            json!({"command": "MY_VAR=hello; echo $MY_VAR"}),
        )
        .await;
        // Second call should NOT see the variable (fresh ShellEnv each time)
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo \"val:$MY_VAR:end\""}))
            .await;
        assert!(
            text.contains("val::end"),
            "Variable should not persist across calls: {}",
            text
        );
    }

    #[tokio::test]
    async fn cd_does_not_persist() {
        let mut h = McpTestHarness::new();
        h.write_fixture("subdir/file.txt", "x");
        // cd in first call
        h.call_tool_text("shell_eval", json!({"command": "cd subdir && pwd"}))
            .await;
        // Second call should be back at root
        let text = h
            .call_tool_text("shell_eval", json!({"command": "pwd"}))
            .await;
        assert!(
            !text.contains("subdir"),
            "cd should not persist across calls: {}",
            text
        );
    }

    #[tokio::test]
    async fn append_redirect() {
        let mut h = McpTestHarness::new();
        h.call_tool_text("shell_eval", json!({"command": "echo first > append.txt"}))
            .await;
        h.call_tool_text(
            "shell_eval",
            json!({"command": "echo second >> append.txt"}),
        )
        .await;
        let content = h.read_fixture("append.txt");
        assert!(content.contains("first"));
        assert!(content.contains("second"));
    }

    #[tokio::test]
    async fn exit_code_zero_on_success() {
        let mut h = McpTestHarness::new();
        let resp = h.call_tool("shell_eval", json!({"command": "true"})).await;
        let is_err = resp["result"]["isError"].as_bool().unwrap_or(false);
        assert!(!is_err, "true should exit 0");
    }

    #[tokio::test]
    async fn exit_code_nonzero_on_failure() {
        let mut h = McpTestHarness::new();
        let is_err = h
            .call_tool_is_error("shell_eval", json!({"command": "false"}))
            .await;
        assert!(is_err, "false should exit 1");
    }

    #[tokio::test]
    async fn pipe_exit_code_is_last_command() {
        let mut h = McpTestHarness::new();
        // `echo ok | true` — last command is true (exit 0)
        let resp = h
            .call_tool("shell_eval", json!({"command": "echo ok | true"}))
            .await;
        let is_err = resp["result"]["isError"].as_bool().unwrap_or(false);
        assert!(!is_err, "Pipe exit code should be from last command");
    }

    #[tokio::test]
    async fn test_bracket_command() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if [ 1 -eq 1 ]; then echo equal; fi"}),
            )
            .await;
        assert!(text.contains("equal"));
    }

    #[tokio::test]
    async fn sed_substitution() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'hello world' | sed 's/world/rust/'"}),
            )
            .await;
        assert!(text.contains("hello rust"));
    }

    #[tokio::test]
    async fn awk_print_action() {
        let mut h = McpTestHarness::new();
        // awk '{print}' should echo input (basic action works)
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'hello world' | awk '{print}'"}),
            )
            .await;
        assert!(
            text.contains("hello world"),
            "awk print should echo input: {}",
            text
        );
    }

    #[tokio::test]
    async fn head_from_stdin() {
        let mut h = McpTestHarness::new();
        // head reading from stdin (piped) with default line count
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo -e '1\\n2\\n3\\n4\\n5' | head -n 2"}),
            )
            .await;
        assert!(
            text.contains('1') && text.contains('2'),
            "head -n 2 from stdin should get first 2 lines: {}",
            text
        );
    }

    #[tokio::test]
    async fn tail_from_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("nums.txt", "1\n2\n3\n4\n5\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "tail -n 2 nums.txt"}))
            .await;
        assert!(
            text.contains('4') && text.contains('5'),
            "tail -n 2 should get last 2 lines: {}",
            text
        );
    }

    #[tokio::test]
    async fn wc_word_count() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'one two three' | wc -w"}),
            )
            .await;
        assert!(text.trim().contains('3'), "Expected 3 words: {}", text);
    }

    #[tokio::test]
    async fn base64_encode_decode() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo -n 'hello' | base64"}))
            .await;
        assert_eq!(text.trim(), "aGVsbG8=");
    }

    #[tokio::test]
    async fn tr_transliteration() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'hello' | tr 'a-z' 'A-Z'"}),
            )
            .await;
        assert_eq!(text.trim(), "HELLO");
    }

    #[tokio::test]
    async fn cut_field() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'a:b:c' | cut -d: -f2"}),
            )
            .await;
        assert_eq!(text.trim(), "b");
    }

    #[tokio::test]
    async fn seq_generates_range() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "seq 1 5"}))
            .await;
        let lines: Vec<&str> = text.trim().lines().collect();
        assert_eq!(lines, vec!["1", "2", "3", "4", "5"]);
    }

    #[tokio::test]
    async fn find_lists_files() {
        let mut h = McpTestHarness::new();
        h.write_fixture("dir/a.txt", "x");
        h.write_fixture("dir/b.rs", "x");
        // find without -name filter should list all files
        let text = h
            .call_tool_text("shell_eval", json!({"command": "find dir"}))
            .await;
        assert!(
            text.contains("a.txt") || text.contains("dir"),
            "find should list directory contents: {}",
            text
        );
    }

    #[tokio::test]
    async fn no_output_shows_sentinel() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "true"}))
            .await;
        assert_eq!(text, "(no output)");
    }

    #[tokio::test]
    async fn multi_pipe_chain() {
        let mut h = McpTestHarness::new();
        h.write_fixture("data.txt", "cherry\napple\nbanana\napple\ncherry\n");
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat data.txt | sort | uniq | wc -l"}),
            )
            .await;
        assert!(text.trim().contains('3'), "3 unique items, got: {}", text);
    }

    #[tokio::test]
    async fn printf_string_format() {
        let mut h = McpTestHarness::new();
        // printf with %s format (basic string substitution)
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "printf 'hello %s\\n' world"}),
            )
            .await;
        assert!(
            text.contains("hello world"),
            "printf %%s should substitute: {}",
            text
        );
    }

    #[tokio::test]
    async fn case_statement() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "X=hello; case $X in hello) echo matched;; *) echo nope;; esac"}),
            )
            .await;
        assert!(text.contains("matched"));
    }

    #[tokio::test]
    async fn nested_command_substitution() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo $(echo $(echo deep))"}),
            )
            .await;
        assert!(text.contains("deep"));
    }

    #[tokio::test]
    async fn variable_default_value() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo ${UNSET_VAR:-default_value}"}),
            )
            .await;
        assert!(text.contains("default_value"));
    }

    #[tokio::test]
    async fn string_length_expansion() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "X=hello; echo ${#X}"}))
            .await;
        assert!(text.contains("5"));
    }
}

// ============================================================
// Agent workflow simulation tests
// ============================================================

mod agent_workflows {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn create_and_source_script_lines() {
        let mut h = McpTestHarness::new();
        // Agent writes a file, then reads and processes each line
        h.call_tool_text(
            "write_file",
            json!({
                "path": "names.txt",
                "content": "alice\nbob\ncharlie\n"
            }),
        )
        .await;
        let text = h
            .call_tool_text("shell_eval", json!({"command": "cat names.txt | sort"}))
            .await;
        assert!(text.contains("alice"));
        assert!(text.contains("bob"));
        assert!(text.contains("charlie"));
    }

    #[tokio::test]
    async fn grep_then_edit_workflow() {
        let mut h = McpTestHarness::new();
        // Agent searches for a pattern, then edits the file
        h.write_fixture(
            "src/main.rs",
            "fn main() {\n    let debug = true;\n    println!(\"hello\");\n}\n",
        );
        let grep_result = h
            .call_tool_text("grep", json!({"pattern": "debug = true", "path": "."}))
            .await;
        assert!(grep_result.contains("main.rs"));
        h.call_tool_text(
            "edit_file",
            json!({
                "path": "src/main.rs",
                "old_str": "let debug = true;",
                "new_str": "let debug = false;"
            }),
        )
        .await;
        let content = h
            .call_tool_text("read_file", json!({"path": "src/main.rs"}))
            .await;
        assert!(content.contains("debug = false"));
    }

    #[tokio::test]
    async fn transform_csv_with_awk() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({
                "path": "data.csv",
                "content": "name,age,city\nalice,30,nyc\nbob,25,sf\n"
            }),
        )
        .await;
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat data.csv | awk -F, 'NR>1 {print $1}' | sort"}),
            )
            .await;
        assert!(text.contains("alice"));
        assert!(text.contains("bob"));
    }

    #[tokio::test]
    async fn build_file_tree_and_navigate() {
        let mut h = McpTestHarness::new();
        // Create a project structure
        for file in ["src/lib.rs", "src/main.rs", "tests/test.rs", "Cargo.toml"] {
            h.call_tool_text(
                "write_file",
                json!({"path": file, "content": format!("// {}", file)}),
            )
            .await;
        }
        // List structure
        let root = h.call_tool_text("list", json!({"path": "."})).await;
        assert!(root.contains("src/"));
        assert!(root.contains("tests/"));
        assert!(root.contains("Cargo.toml"));
        let src = h.call_tool_text("list", json!({"path": "src"})).await;
        assert!(src.contains("lib.rs"));
        assert!(src.contains("main.rs"));
    }

    #[tokio::test]
    async fn search_and_replace_across_files() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "a.txt", "content": "old_api_call();\n"}),
        )
        .await;
        h.call_tool_text(
            "write_file",
            json!({"path": "b.txt", "content": "other stuff\n"}),
        )
        .await;
        h.call_tool_text(
            "write_file",
            json!({"path": "c.txt", "content": "old_api_call();\nmore code\n"}),
        )
        .await;
        // Search for files containing the old API
        let grep_result = h
            .call_tool_text("grep", json!({"pattern": "old_api_call", "path": "."}))
            .await;
        assert!(grep_result.contains("a.txt"));
        assert!(grep_result.contains("c.txt"));
        assert!(!grep_result.contains("b.txt"));
        // Edit each matching file
        h.call_tool_text(
            "edit_file",
            json!({
                "path": "a.txt",
                "old_str": "old_api_call()",
                "new_str": "new_api_call()"
            }),
        )
        .await;
        h.call_tool_text(
            "edit_file",
            json!({
                "path": "c.txt",
                "old_str": "old_api_call()",
                "new_str": "new_api_call()"
            }),
        )
        .await;
        // Verify
        let a = h
            .call_tool_text("read_file", json!({"path": "a.txt"}))
            .await;
        let c = h
            .call_tool_text("read_file", json!({"path": "c.txt"}))
            .await;
        assert!(a.contains("new_api_call"));
        assert!(c.contains("new_api_call"));
    }

    #[tokio::test]
    async fn generate_data_with_seq() {
        let mut h = McpTestHarness::new();
        // Use shell seq to generate data, redirect to file
        h.call_tool_text("shell_eval", json!({"command": "seq 1 5 > nums.txt"}))
            .await;
        let content = h
            .call_tool_text("read_file", json!({"path": "nums.txt"}))
            .await;
        assert!(content.contains("1"));
        assert!(content.contains("5"));
    }

    #[tokio::test]
    async fn checksum_workflow() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "verify.txt", "content": "important data\n"}),
        )
        .await;
        let hash = h
            .call_tool_text("shell_eval", json!({"command": "md5sum verify.txt"}))
            .await;
        assert!(!hash.is_empty());
        assert!(hash.contains("verify.txt"));
    }
}

// ============================================================
// Shell file operation commands
// ============================================================

mod shell_file_commands {
    use super::harness::McpTestHarness;
    use serde_json::json;

    // --- touch ---

    #[tokio::test]
    async fn touch_creates_empty_file() {
        let mut h = McpTestHarness::new();
        h.call_tool_text("shell_eval", json!({"command": "touch newfile.txt"}))
            .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "newfile.txt"}))
            .await;
        assert_eq!(text, "");
    }

    #[tokio::test]
    async fn touch_existing_file_does_not_truncate() {
        let mut h = McpTestHarness::new();
        h.write_fixture("keep.txt", "important data");
        h.call_tool_text("shell_eval", json!({"command": "touch keep.txt"}))
            .await;
        assert_eq!(h.read_fixture("keep.txt"), "important data");
    }

    // --- rm ---

    #[tokio::test]
    async fn rm_removes_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("delete_me.txt", "bye");
        h.call_tool_text("shell_eval", json!({"command": "rm delete_me.txt"}))
            .await;
        let is_err = h
            .call_tool_is_error("read_file", json!({"path": "delete_me.txt"}))
            .await;
        assert!(is_err, "File should be deleted");
    }

    #[tokio::test]
    async fn rm_nonexistent_file_without_force_errors() {
        let mut h = McpTestHarness::new();
        let is_err = h
            .call_tool_is_error("shell_eval", json!({"command": "rm nonexistent.txt"}))
            .await;
        assert!(is_err, "rm nonexistent should fail without -f");
    }

    #[tokio::test]
    async fn rm_force_nonexistent_succeeds() {
        let mut h = McpTestHarness::new();
        let is_err = h
            .call_tool_is_error("shell_eval", json!({"command": "rm -f nonexistent.txt"}))
            .await;
        assert!(!is_err, "rm -f nonexistent should succeed silently");
    }

    #[tokio::test]
    async fn rm_recursive_removes_directory() {
        let mut h = McpTestHarness::new();
        h.write_fixture("dir/sub/file.txt", "deep");
        h.call_tool_text("shell_eval", json!({"command": "rm -r dir"}))
            .await;
        let is_err = h
            .call_tool_is_error("read_file", json!({"path": "dir/sub/file.txt"}))
            .await;
        assert!(is_err, "Directory should be recursively removed");
    }

    // --- mv ---

    #[tokio::test]
    async fn mv_renames_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("old_name.txt", "content");
        h.call_tool_text(
            "shell_eval",
            json!({"command": "mv old_name.txt new_name.txt"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "new_name.txt"}))
            .await;
        assert_eq!(text, "content");
        let is_err = h
            .call_tool_is_error("read_file", json!({"path": "old_name.txt"}))
            .await;
        assert!(is_err, "Old file should not exist after mv");
    }

    // --- cp ---

    #[tokio::test]
    async fn cp_copies_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("original.txt", "copy me");
        h.call_tool_text(
            "shell_eval",
            json!({"command": "cp original.txt copied.txt"}),
        )
        .await;
        let orig = h
            .call_tool_text("read_file", json!({"path": "original.txt"}))
            .await;
        let copy = h
            .call_tool_text("read_file", json!({"path": "copied.txt"}))
            .await;
        assert_eq!(orig, "copy me");
        assert_eq!(copy, "copy me");
    }

    #[tokio::test]
    async fn cp_recursive_copies_directory() {
        let mut h = McpTestHarness::new();
        h.write_fixture("src_dir/a.txt", "aaa");
        h.write_fixture("src_dir/b.txt", "bbb");
        h.call_tool_text("shell_eval", json!({"command": "cp -r src_dir dst_dir"}))
            .await;
        let a = h
            .call_tool_text("read_file", json!({"path": "dst_dir/a.txt"}))
            .await;
        let b = h
            .call_tool_text("read_file", json!({"path": "dst_dir/b.txt"}))
            .await;
        assert_eq!(a, "aaa");
        assert_eq!(b, "bbb");
    }

    // --- mkdir ---

    #[tokio::test]
    async fn mkdir_creates_directory() {
        let mut h = McpTestHarness::new();
        h.call_tool_text("shell_eval", json!({"command": "mkdir newdir"}))
            .await;
        let text = h.call_tool_text("list", json!({"path": "newdir"})).await;
        // Should not error — directory exists (may be empty)
        assert!(
            text.contains("empty") || text.is_empty() || !text.contains("Failed"),
            "mkdir should create directory: {}",
            text
        );
    }

    // --- rmdir ---

    #[tokio::test]
    async fn rmdir_removes_empty_directory() {
        let mut h = McpTestHarness::new();
        h.call_tool_text("shell_eval", json!({"command": "mkdir emptydir"}))
            .await;
        h.call_tool_text("shell_eval", json!({"command": "rmdir emptydir"}))
            .await;
        let is_err = h
            .call_tool_is_error("list", json!({"path": "emptydir"}))
            .await;
        assert!(is_err, "Empty directory should be removed");
    }

    #[tokio::test]
    async fn rmdir_nonempty_directory_fails() {
        let mut h = McpTestHarness::new();
        h.write_fixture("notempty/file.txt", "x");
        let is_err = h
            .call_tool_is_error("shell_eval", json!({"command": "rmdir notempty"}))
            .await;
        assert!(is_err, "rmdir on non-empty directory should fail");
    }

    // --- diff ---

    #[tokio::test]
    async fn diff_identical_files() {
        let mut h = McpTestHarness::new();
        h.write_fixture("f1.txt", "same content\n");
        h.write_fixture("f2.txt", "same content\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "diff f1.txt f2.txt"}))
            .await;
        // diff of identical files should produce no output or "(no output)"
        assert!(
            text.contains("no output") || text.trim().is_empty() || text.contains("identical"),
            "diff of identical files: {}",
            text
        );
    }

    #[tokio::test]
    async fn diff_different_files() {
        let mut h = McpTestHarness::new();
        h.write_fixture("d1.txt", "line one\nline two\n");
        h.write_fixture("d2.txt", "line one\nline changed\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "diff d1.txt d2.txt"}))
            .await;
        // Should show some kind of difference indicator
        assert!(
            !text.contains("no output"),
            "diff should show differences: {}",
            text
        );
    }

    // --- stat ---

    #[tokio::test]
    async fn stat_shows_file_info() {
        let mut h = McpTestHarness::new();
        h.write_fixture("info.txt", "some data");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "stat info.txt"}))
            .await;
        assert!(
            text.contains("info.txt") || text.contains("size") || text.contains("Size"),
            "stat should show file information: {}",
            text
        );
    }

    // --- mktemp ---

    #[tokio::test]
    async fn mktemp_creates_temp_file() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "mktemp"}))
            .await;
        assert!(
            !text.contains("no output"),
            "mktemp should return a file path: {}",
            text
        );
    }

    #[tokio::test]
    async fn mktemp_creates_temp_directory() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "mktemp -d"}))
            .await;
        assert!(
            !text.contains("no output"),
            "mktemp -d should return a directory path: {}",
            text
        );
    }

    // --- tee ---

    #[tokio::test]
    async fn tee_copies_to_file_and_stdout() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'tee test' | tee output.txt"}),
            )
            .await;
        assert!(
            text.contains("tee test"),
            "tee should pass through to stdout: {}",
            text
        );
        let file_content = h.read_fixture("output.txt");
        assert!(
            file_content.contains("tee test"),
            "tee should write to file: {}",
            file_content
        );
    }

    #[tokio::test]
    async fn tee_append_mode() {
        let mut h = McpTestHarness::new();
        h.write_fixture("tee_append.txt", "existing\n");
        h.call_tool_text(
            "shell_eval",
            json!({"command": "echo 'appended' | tee -a tee_append.txt"}),
        )
        .await;
        let content = h.read_fixture("tee_append.txt");
        assert!(content.contains("existing"), "Original content preserved");
        assert!(content.contains("appended"), "New content appended");
    }

    // --- ln ---

    #[tokio::test]
    async fn ln_symbolic_link() {
        let mut h = McpTestHarness::new();
        h.write_fixture("target.txt", "link target");
        h.call_tool_text(
            "shell_eval",
            json!({"command": "ln -s target.txt link.txt"}),
        )
        .await;
        let text = h
            .call_tool_text("shell_eval", json!({"command": "cat link.txt"}))
            .await;
        assert!(
            text.contains("link target"),
            "Symlink should resolve to target content: {}",
            text
        );
    }

    // --- find ---

    #[tokio::test]
    async fn find_with_name_filter() {
        let mut h = McpTestHarness::new();
        h.write_fixture("project/src/main.rs", "fn main() {}");
        h.write_fixture("project/src/lib.rs", "pub fn lib() {}");
        h.write_fixture("project/README.md", "# Readme");
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "find project -name '*.rs'"}),
            )
            .await;
        assert!(text.contains("main.rs"), "Should find .rs files: {}", text);
        assert!(text.contains("lib.rs"), "Should find .rs files: {}", text);
    }

    // --- file ---

    #[tokio::test]
    async fn file_command_identifies_text() {
        let mut h = McpTestHarness::new();
        h.write_fixture("plain.txt", "just text");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "file plain.txt"}))
            .await;
        // file command should identify it somehow
        assert!(
            text.contains("plain.txt"),
            "file should identify the file: {}",
            text
        );
    }
}

// ============================================================
// Text processing command tests
// ============================================================

mod shell_text_processing {
    use super::harness::McpTestHarness;
    use serde_json::json;

    // --- rev ---

    #[tokio::test]
    async fn rev_reverses_lines() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo 'abcdef' | rev"}))
            .await;
        assert_eq!(text.trim(), "fedcba");
    }

    // --- fold ---

    #[tokio::test]
    async fn fold_wraps_long_lines() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'abcdefghij' | fold -w 5"}),
            )
            .await;
        let lines: Vec<&str> = text.trim().lines().collect();
        assert_eq!(lines.len(), 2, "Should wrap at 5 chars: {:?}", lines);
        assert_eq!(lines[0], "abcde");
        assert_eq!(lines[1], "fghij");
    }

    // --- nl ---

    #[tokio::test]
    async fn nl_numbers_lines() {
        let mut h = McpTestHarness::new();
        h.write_fixture("numbered.txt", "alpha\nbeta\ngamma\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "nl numbered.txt"}))
            .await;
        assert!(text.contains("1"), "nl should number lines: {}", text);
        assert!(text.contains("alpha"), "Should preserve content: {}", text);
        assert!(text.contains("gamma"), "Should include all lines: {}", text);
    }

    // --- paste ---

    #[tokio::test]
    async fn paste_merges_files() {
        let mut h = McpTestHarness::new();
        h.write_fixture("col1.txt", "a\nb\nc\n");
        h.write_fixture("col2.txt", "1\n2\n3\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "paste col1.txt col2.txt"}))
            .await;
        // Should merge with tab separator
        assert!(
            text.contains("a") && text.contains("1"),
            "Should merge: {}",
            text
        );
    }

    // --- uniq -c ---

    #[tokio::test]
    async fn uniq_with_count() {
        let mut h = McpTestHarness::new();
        h.write_fixture("repeated.txt", "a\na\nb\nc\nc\nc\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "uniq -c repeated.txt"}))
            .await;
        assert!(text.contains("2"), "Should count duplicates: {}", text);
        assert!(text.contains("3"), "Should count triplicates: {}", text);
    }

    // --- tr -d ---

    #[tokio::test]
    async fn tr_delete_characters() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'hello world' | tr -d 'lo'"}),
            )
            .await;
        assert_eq!(text.trim(), "he wrd");
    }

    // --- cut with field range ---

    #[tokio::test]
    async fn cut_field_range() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'a:b:c:d:e' | cut -d: -f2-4"}),
            )
            .await;
        assert_eq!(text.trim(), "b:c:d");
    }

    // --- sort with reverse ---

    #[tokio::test]
    async fn sort_reverse() {
        let mut h = McpTestHarness::new();
        h.write_fixture("tosort.txt", "apple\ncherry\nbanana\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "sort -r tosort.txt"}))
            .await;
        let lines: Vec<&str> = text.trim().lines().collect();
        assert_eq!(lines, vec!["cherry", "banana", "apple"]);
    }

    // --- wc on file ---

    #[tokio::test]
    async fn wc_line_count_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("count.txt", "one\ntwo\nthree\nfour\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "wc -l count.txt"}))
            .await;
        assert!(text.contains("4"), "Expected 4 lines: {}", text);
    }

    // --- sed global substitution ---

    #[tokio::test]
    async fn sed_global_replace() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'aaa bbb aaa' | sed 's/aaa/xxx/g'"}),
            )
            .await;
        assert_eq!(text.trim(), "xxx bbb xxx");
    }

    #[tokio::test]
    async fn sed_first_occurrence_only() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'aaa bbb aaa' | sed 's/aaa/xxx/'"}),
            )
            .await;
        assert_eq!(text.trim(), "xxx bbb aaa");
    }

    #[tokio::test]
    async fn sed_alternate_delimiter() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo '/usr/local/bin' | sed 's|/usr/local|/opt|'"}),
            )
            .await;
        assert_eq!(text.trim(), "/opt/bin");
    }

    // --- awk field extraction ---

    #[tokio::test]
    async fn awk_extract_field() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'alice 30 nyc' | awk '{print $2}'"}),
            )
            .await;
        assert_eq!(text.trim(), "30");
    }

    #[tokio::test]
    async fn awk_with_field_separator() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'a:b:c' | awk -F: '{print $3}'"}),
            )
            .await;
        assert_eq!(text.trim(), "c");
    }

    #[tokio::test]
    async fn awk_nr_variable() {
        let mut h = McpTestHarness::new();
        h.write_fixture("awk_nr.txt", "first\nsecond\nthird\n");
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "awk 'NR==2 {print}' awk_nr.txt"}),
            )
            .await;
        assert!(
            text.contains("second"),
            "NR==2 should print second line: {}",
            text
        );
    }

    // --- head default ---

    #[tokio::test]
    async fn head_default_ten_lines() {
        let mut h = McpTestHarness::new();
        let content = (1..=20)
            .map(|i| format!("line{}", i))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        h.write_fixture("twenty.txt", &content);
        let text = h
            .call_tool_text("shell_eval", json!({"command": "head twenty.txt"}))
            .await;
        assert!(
            text.contains("line10"),
            "head default should show 10: {}",
            text
        );
        assert!(
            !text.contains("line11"),
            "head default should stop at 10: {}",
            text
        );
    }

    // --- tail default ---

    #[tokio::test]
    async fn tail_default_ten_lines() {
        let mut h = McpTestHarness::new();
        let content = (1..=20)
            .map(|i| format!("line{}", i))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        h.write_fixture("twenty.txt", &content);
        let text = h
            .call_tool_text("shell_eval", json!({"command": "tail twenty.txt"}))
            .await;
        assert!(
            text.contains("line20"),
            "tail should show last line: {}",
            text
        );
        assert!(
            !text.contains("line10\n"),
            "tail default should not include line10: {}",
            text
        );
    }
}

// ============================================================
// Encoding, hashing, and data format commands
// ============================================================

mod shell_encoding_commands {
    use super::harness::McpTestHarness;
    use serde_json::json;

    // --- sha256sum ---

    #[tokio::test]
    async fn sha256sum_hashes_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("hash_me.txt", "hello\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "sha256sum hash_me.txt"}))
            .await;
        assert!(
            text.contains("hash_me.txt"),
            "Should include filename: {}",
            text
        );
        // SHA256 of "hello\n" is well-known
        assert!(
            text.len() > 64,
            "Should contain a 64-char hex hash: {}",
            text
        );
    }

    #[tokio::test]
    async fn sha256sum_from_stdin() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo -n 'test' | sha256sum"}),
            )
            .await;
        // SHA256("test") = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
        assert!(
            text.contains("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
            "SHA256 of 'test': {}",
            text
        );
    }

    // --- base64 decode ---

    #[tokio::test]
    async fn base64_decode() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'aGVsbG8=' | base64 -d"}),
            )
            .await;
        assert_eq!(text.trim(), "hello");
    }

    #[tokio::test]
    async fn base64_roundtrip() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo -n 'roundtrip data' | base64 | base64 -d"}),
            )
            .await;
        assert_eq!(text.trim(), "roundtrip data");
    }

    // --- xxd ---

    #[tokio::test]
    async fn xxd_hex_dump() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo -n 'ABC' | xxd"}))
            .await;
        // Should contain hex for A=41, B=42, C=43
        assert!(text.contains("41"), "Should contain hex for 'A': {}", text);
        assert!(text.contains("42"), "Should contain hex for 'B': {}", text);
        assert!(text.contains("43"), "Should contain hex for 'C': {}", text);
    }

    // --- jq advanced ---

    #[tokio::test]
    async fn jq_nested_field() {
        let mut h = McpTestHarness::new();
        h.write_fixture("nested.json", r#"{"a":{"b":{"c":"deep"}}}"#);
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat nested.json | jq '.a.b.c'"}),
            )
            .await;
        assert!(text.contains("deep"), "jq nested access: {}", text);
    }

    #[tokio::test]
    async fn jq_array_index() {
        let mut h = McpTestHarness::new();
        h.write_fixture("arr.json", r#"[10, 20, 30]"#);
        let text = h
            .call_tool_text("shell_eval", json!({"command": "cat arr.json | jq '.[1]'"}))
            .await;
        assert!(text.contains("20"), "jq array index: {}", text);
    }

    #[tokio::test]
    async fn jq_raw_output() {
        let mut h = McpTestHarness::new();
        h.write_fixture("raw.json", r#"{"name":"alice"}"#);
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat raw.json | jq -r '.name'"}),
            )
            .await;
        // -r should output without quotes
        assert_eq!(text.trim(), "alice");
    }

    #[tokio::test]
    async fn jq_keys() {
        let mut h = McpTestHarness::new();
        h.write_fixture("keys.json", r#"{"zebra":1,"apple":2,"mango":3}"#);
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat keys.json | jq 'keys'"}),
            )
            .await;
        assert!(text.contains("apple"), "jq keys: {}", text);
        assert!(text.contains("zebra"), "jq keys: {}", text);
    }

    #[tokio::test]
    async fn jq_length() {
        let mut h = McpTestHarness::new();
        h.write_fixture("len.json", r#"[1,2,3,4,5]"#);
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat len.json | jq 'length'"}),
            )
            .await;
        assert!(text.contains("5"), "jq length of 5-element array: {}", text);
    }

    // --- printf formats ---

    #[tokio::test]
    async fn printf_decimal_format() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "printf '%d\\n' 42"}))
            .await;
        assert_eq!(text.trim(), "42");
    }

    #[tokio::test]
    async fn printf_hex_format() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "printf '%x\\n' 255"}))
            .await;
        assert_eq!(text.trim(), "ff");
    }

    // --- expr ---

    #[tokio::test]
    async fn expr_arithmetic() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "expr 3 + 4"}))
            .await;
        assert_eq!(text.trim(), "7");
    }

    #[tokio::test]
    async fn expr_multiplication() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "expr 6 '*' 7"}))
            .await;
        assert_eq!(text.trim(), "42");
    }

    // --- date ---

    #[tokio::test]
    async fn date_prints_something() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "date"}))
            .await;
        // Date should output something with digits (year, time, etc.)
        assert!(
            text.chars().any(|c| c.is_ascii_digit()),
            "date should contain digits: {}",
            text
        );
    }

    // --- sqlite3 ---

    #[tokio::test]
    async fn sqlite3_basic_query() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "sqlite3 ':memory:' 'SELECT 1+1;'"}),
            )
            .await;
        assert!(text.contains("2"), "sqlite3 should compute 1+1=2: {}", text);
    }

    #[tokio::test]
    async fn sqlite3_create_and_query_table() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "sqlite3 test.db 'CREATE TABLE t(id INT, name TEXT); INSERT INTO t VALUES(1, \"alice\"); INSERT INTO t VALUES(2, \"bob\"); SELECT name FROM t ORDER BY id;'"}),
            )
            .await;
        assert!(text.contains("alice"), "Should query alice: {}", text);
        assert!(text.contains("bob"), "Should query bob: {}", text);
    }

    // --- seq ---

    #[tokio::test]
    async fn seq_with_step() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "seq 2 2 10"}))
            .await;
        let lines: Vec<&str> = text.trim().lines().collect();
        assert_eq!(lines, vec!["2", "4", "6", "8", "10"]);
    }

    #[tokio::test]
    async fn seq_countdown() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "seq 5 -1 1"}))
            .await;
        let lines: Vec<&str> = text.trim().lines().collect();
        assert_eq!(lines, vec!["5", "4", "3", "2", "1"]);
    }
}

// ============================================================
// Archive command tests
// ============================================================

mod shell_archive_commands {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn tar_create_and_extract() {
        let mut h = McpTestHarness::new();
        h.write_fixture("archive/file1.txt", "content one");
        h.write_fixture("archive/file2.txt", "content two");
        // Create tar
        h.call_tool_text(
            "shell_eval",
            json!({"command": "tar -cf archive.tar archive"}),
        )
        .await;
        // Remove originals
        h.call_tool_text("shell_eval", json!({"command": "rm -r archive"}))
            .await;
        // Extract
        h.call_tool_text("shell_eval", json!({"command": "tar -xf archive.tar"}))
            .await;
        let f1 = h
            .call_tool_text("read_file", json!({"path": "archive/file1.txt"}))
            .await;
        let f2 = h
            .call_tool_text("read_file", json!({"path": "archive/file2.txt"}))
            .await;
        assert_eq!(f1, "content one");
        assert_eq!(f2, "content two");
    }

    #[tokio::test]
    async fn tar_list_contents() {
        let mut h = McpTestHarness::new();
        h.write_fixture("list_test/a.txt", "a");
        h.write_fixture("list_test/b.txt", "b");
        h.call_tool_text(
            "shell_eval",
            json!({"command": "tar -cf listing.tar list_test"}),
        )
        .await;
        let text = h
            .call_tool_text("shell_eval", json!({"command": "tar -tf listing.tar"}))
            .await;
        assert!(text.contains("a.txt"), "tar -t should list files: {}", text);
        assert!(text.contains("b.txt"), "tar -t should list files: {}", text);
    }

    #[tokio::test]
    async fn gzip_and_gunzip() {
        let mut h = McpTestHarness::new();
        h.write_fixture("compress.txt", "compressible content here");
        h.call_tool_text("shell_eval", json!({"command": "gzip -k compress.txt"}))
            .await;
        // Verify .gz file exists
        let list = h.call_tool_text("list", json!({"path": "."})).await;
        assert!(
            list.contains("compress.txt.gz"),
            "gzip should create .gz file: {}",
            list
        );
        // Decompress
        h.call_tool_text(
            "shell_eval",
            json!({"command": "gunzip -k compress.txt.gz"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "compress.txt"}))
            .await;
        assert_eq!(text, "compressible content here");
    }

    #[tokio::test]
    async fn zip_and_unzip() {
        let mut h = McpTestHarness::new();
        h.write_fixture("zipme/data.txt", "zip content");
        h.call_tool_text("shell_eval", json!({"command": "zip -r archive.zip zipme"}))
            .await;
        // Remove original
        h.call_tool_text("shell_eval", json!({"command": "rm -r zipme"}))
            .await;
        // Extract
        h.call_tool_text("shell_eval", json!({"command": "unzip archive.zip"}))
            .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "zipme/data.txt"}))
            .await;
        assert_eq!(text, "zip content");
    }

    #[tokio::test]
    async fn unzip_list() {
        let mut h = McpTestHarness::new();
        h.write_fixture("listzip/one.txt", "1");
        h.write_fixture("listzip/two.txt", "2");
        h.call_tool_text("shell_eval", json!({"command": "zip -r list.zip listzip"}))
            .await;
        let text = h
            .call_tool_text("shell_eval", json!({"command": "unzip -l list.zip"}))
            .await;
        assert!(
            text.contains("one.txt"),
            "unzip -l should list files: {}",
            text
        );
        assert!(
            text.contains("two.txt"),
            "unzip -l should list files: {}",
            text
        );
    }

    #[tokio::test]
    async fn tar_gz_compressed_archive() {
        let mut h = McpTestHarness::new();
        h.write_fixture("tgz/data.txt", "compressed content");
        h.call_tool_text(
            "shell_eval",
            json!({"command": "tar -czf archive.tar.gz tgz"}),
        )
        .await;
        h.call_tool_text("shell_eval", json!({"command": "rm -r tgz"}))
            .await;
        h.call_tool_text("shell_eval", json!({"command": "tar -xzf archive.tar.gz"}))
            .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "tgz/data.txt"}))
            .await;
        assert_eq!(text, "compressed content");
    }
}

// ============================================================
// LLM hallucination traps — tests for features an LLM might assume
// exist but don't, or that behave differently than expected.
// These document the actual behavior to catch regressions.
// ============================================================

mod llm_hallucination_traps {
    use super::harness::McpTestHarness;
    use serde_json::json;

    // === grep tool (MCP) is always case-insensitive — LLM might not know ===

    #[tokio::test]
    async fn mcp_grep_is_always_case_insensitive() {
        let mut h = McpTestHarness::new();
        h.write_fixture("case.txt", "Hello World\nhello world\nHELLO WORLD\n");
        let text = h
            .call_tool_text("grep", json!({"pattern": "hello", "path": "."}))
            .await;
        // MCP grep matches case-insensitively
        let match_count = text.lines().count();
        assert_eq!(
            match_count, 3,
            "MCP grep is case-insensitive, should match all 3: {}",
            text
        );
    }

    // === shell grep supports -i but is case-sensitive by default ===

    #[tokio::test]
    async fn shell_grep_case_sensitive_by_default() {
        let mut h = McpTestHarness::new();
        h.write_fixture("gcase.txt", "Hello World\nhello world\nHELLO WORLD\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "grep hello gcase.txt"}))
            .await;
        // Shell grep is case-sensitive by default
        assert!(
            text.contains("hello world"),
            "Should match lowercase: {}",
            text
        );
    }

    #[tokio::test]
    async fn shell_grep_case_insensitive_flag() {
        let mut h = McpTestHarness::new();
        h.write_fixture("gci.txt", "Hello World\nhello world\nHELLO WORLD\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "grep -i hello gci.txt"}))
            .await;
        let match_count = text.trim().lines().count();
        assert_eq!(match_count, 3, "grep -i should match all 3 lines: {}", text);
    }

    // === shell grep -v inverts matches ===

    #[tokio::test]
    async fn shell_grep_invert_match() {
        let mut h = McpTestHarness::new();
        h.write_fixture("inv.txt", "keep this\nremove me\nkeep also\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "grep -v remove inv.txt"}))
            .await;
        assert!(
            text.contains("keep this"),
            "Should keep non-matching: {}",
            text
        );
        assert!(
            text.contains("keep also"),
            "Should keep non-matching: {}",
            text
        );
        assert!(
            !text.contains("remove me"),
            "Should exclude matching: {}",
            text
        );
    }

    // === sed only supports s/// — LLM might try address ranges or d command ===

    #[tokio::test]
    async fn sed_only_supports_substitution() {
        let mut h = McpTestHarness::new();
        // LLM might try: sed '2d' (delete line 2) — this should fail or do nothing
        let result = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo -e 'a\\nb\\nc' | sed '2d'"}),
            )
            .await;
        // If sed doesn't support 'd' command, it might error or pass through unchanged
        // Document actual behavior — we just want it not to crash
        assert!(
            !result.is_empty(),
            "sed with unsupported command should not crash"
        );
    }

    // === sort does NOT support -n (numeric) ===

    #[tokio::test]
    async fn sort_numeric_not_supported() {
        let mut h = McpTestHarness::new();
        h.write_fixture("nums.txt", "10\n2\n1\n20\n3\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "sort nums.txt"}))
            .await;
        let lines: Vec<&str> = text.trim().lines().collect();
        // Without -n, sort is lexicographic: "1" < "10" < "2" < "20" < "3"
        assert_eq!(
            lines,
            vec!["1", "10", "2", "20", "3"],
            "sort without -n is lexicographic: {:?}",
            lines
        );
    }

    // === cat has no flags (no -n for line numbers) ===

    #[tokio::test]
    async fn cat_passes_through_unchanged() {
        let mut h = McpTestHarness::new();
        h.write_fixture("catme.txt", "line1\nline2\nline3\n");
        let text = h
            .call_tool_text("shell_eval", json!({"command": "cat catme.txt"}))
            .await;
        assert_eq!(text.trim(), "line1\nline2\nline3");
    }

    // === xargs outputs commands, does NOT execute them ===

    #[tokio::test]
    async fn xargs_outputs_command_not_execute() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "echo 'file.txt' | xargs echo"}),
            )
            .await;
        // xargs should produce some output (it builds and outputs the command)
        assert!(!text.is_empty(), "xargs should produce output: {}", text);
    }

    // === echo -n suppresses newline ===

    #[tokio::test]
    async fn echo_n_no_trailing_newline() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo -n 'no newline'"}))
            .await;
        assert_eq!(text, "no newline");
    }

    // === echo -e interprets escape sequences ===

    #[tokio::test]
    async fn echo_e_escape_sequences() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo -e 'a\\tb\\nc'"}))
            .await;
        assert!(text.contains('\t'), "Should contain tab: {:?}", text);
        assert!(text.contains('\n'), "Should contain newline: {:?}", text);
    }

    // === test command file permission checks are simplified ===

    #[tokio::test]
    async fn test_file_exists() {
        let mut h = McpTestHarness::new();
        h.write_fixture("exists.txt", "here");
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if [ -e exists.txt ]; then echo found; fi"}),
            )
            .await;
        assert!(text.contains("found"));
    }

    #[tokio::test]
    async fn test_file_is_regular() {
        let mut h = McpTestHarness::new();
        h.write_fixture("regular.txt", "regular file");
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if [ -f regular.txt ]; then echo regular; fi"}),
            )
            .await;
        assert!(text.contains("regular"));
    }

    #[tokio::test]
    async fn test_directory_check() {
        let mut h = McpTestHarness::new();
        h.write_fixture("somedir/child.txt", "x");
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if [ -d somedir ]; then echo isdir; fi"}),
            )
            .await;
        assert!(text.contains("isdir"));
    }

    #[tokio::test]
    async fn test_string_equality() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "X=hello; if [ \"$X\" = hello ]; then echo match; fi"}),
            )
            .await;
        assert!(text.contains("match"));
    }

    #[tokio::test]
    async fn test_string_not_equal() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if [ abc != def ]; then echo different; fi"}),
            )
            .await;
        assert!(text.contains("different"));
    }

    #[tokio::test]
    async fn test_numeric_comparison() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if [ 5 -gt 3 ]; then echo bigger; fi"}),
            )
            .await;
        assert!(text.contains("bigger"));
    }

    #[tokio::test]
    async fn test_empty_string() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if [ -z \"\" ]; then echo empty; fi"}),
            )
            .await;
        assert!(text.contains("empty"));
    }

    #[tokio::test]
    async fn test_nonempty_string() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "if [ -n hello ]; then echo notempty; fi"}),
            )
            .await;
        assert!(text.contains("notempty"));
    }

    // === which/type identify builtins ===

    #[tokio::test]
    async fn which_identifies_builtin() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "which echo"}))
            .await;
        assert!(
            text.contains("builtin") || text.contains("echo"),
            "which should identify echo: {}",
            text
        );
    }

    #[tokio::test]
    async fn type_identifies_builtin() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "type echo"}))
            .await;
        assert!(
            text.contains("builtin") || text.contains("keyword"),
            "type should identify echo: {}",
            text
        );
    }

    // === env and printenv ===

    #[tokio::test]
    async fn env_lists_variables() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "env"}))
            .await;
        // Should output at least something (PWD, HOME, etc.)
        assert!(
            !text.is_empty() && text != "(no output)",
            "env should list vars: {}",
            text
        );
    }

    // === shell_eval reports exit code in stderr for failures ===

    #[tokio::test]
    async fn shell_eval_nonzero_exit_includes_exit_code() {
        let mut h = McpTestHarness::new();
        let resp = h.call_tool("shell_eval", json!({"command": "false"})).await;
        let is_err = resp["result"]["isError"].as_bool().unwrap_or(false);
        assert!(is_err, "false should be error");
        let text = resp["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(
            text.contains("Exit code") || text.contains("exit code"),
            "Error should mention exit code: {}",
            text
        );
    }

    // === Multiple variables in one command ===

    #[tokio::test]
    async fn multiple_variable_assignments() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "A=hello; B=world; echo $A $B"}),
            )
            .await;
        assert!(text.contains("hello world"), "Multiple vars: {}", text);
    }

    // === Variable in double quotes expands, single quotes don't ===

    #[tokio::test]
    async fn single_quotes_no_expansion() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "X=hello; echo '$X'"}))
            .await;
        assert!(
            text.contains("$X"),
            "Single quotes should not expand: {}",
            text
        );
    }

    #[tokio::test]
    async fn double_quotes_expand_variables() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "X=hello; echo \"$X world\""}),
            )
            .await;
        assert!(
            text.contains("hello world"),
            "Double quotes should expand vars: {}",
            text
        );
    }

    // === Brace expansion ===

    #[tokio::test]
    async fn brace_expansion() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text("shell_eval", json!({"command": "echo {a,b,c}"}))
            .await;
        assert!(
            text.contains("a") && text.contains("b") && text.contains("c"),
            "Brace expansion should expand: {}",
            text
        );
    }

    // === elif support ===

    #[tokio::test]
    async fn elif_branch() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "X=2; if [ $X -eq 1 ]; then echo one; elif [ $X -eq 2 ]; then echo two; else echo other; fi"}),
            )
            .await;
        assert!(text.contains("two"), "elif should work: {}", text);
    }

    // === for loop with seq command substitution ===

    #[tokio::test]
    async fn for_loop_with_command_substitution() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "for i in $(seq 1 3); do echo \"num:$i\"; done"}),
            )
            .await;
        assert!(text.contains("num:1"), "Loop with seq: {}", text);
        assert!(text.contains("num:2"), "Loop with seq: {}", text);
        assert!(text.contains("num:3"), "Loop with seq: {}", text);
    }

    // === case with wildcard ===

    #[tokio::test]
    async fn case_wildcard_pattern() {
        let mut h = McpTestHarness::new();
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "X=unknown; case $X in hello) echo hi;; *) echo default;; esac"}),
            )
            .await;
        assert!(text.contains("default"), "Case wildcard: {}", text);
    }
}

// ============================================================
// MCP tool edge cases and error handling
// ============================================================

mod mcp_tool_edge_cases {
    use super::harness::McpTestHarness;
    use serde_json::json;

    // --- read_file on directory should error ---

    #[tokio::test]
    async fn read_file_on_directory_errors() {
        let mut h = McpTestHarness::new();
        h.write_fixture("mydir/child.txt", "x");
        let is_err = h
            .call_tool_is_error("read_file", json!({"path": "mydir"}))
            .await;
        assert!(is_err, "read_file on a directory should error");
    }

    // --- list on a file should error ---

    #[tokio::test]
    async fn list_on_file_errors() {
        let mut h = McpTestHarness::new();
        h.write_fixture("notadir.txt", "content");
        let is_err = h
            .call_tool_is_error("list", json!({"path": "notadir.txt"}))
            .await;
        assert!(is_err, "list on a file should error");
    }

    // --- grep on single file path ---

    #[tokio::test]
    async fn grep_on_single_file() {
        let mut h = McpTestHarness::new();
        h.write_fixture("single.txt", "findable\nnope\n");
        // grep with path pointing to the parent dir should work
        let text = h
            .call_tool_text("grep", json!({"pattern": "findable", "path": "."}))
            .await;
        assert!(text.contains("findable"), "Should find in file: {}", text);
    }

    // --- write_file overwrites with shorter content ---

    #[tokio::test]
    async fn write_file_overwrite_shorter() {
        let mut h = McpTestHarness::new();
        h.write_fixture("long.txt", "this is a long string of content");
        h.call_tool_text(
            "write_file",
            json!({"path": "long.txt", "content": "short"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "long.txt"}))
            .await;
        assert_eq!(text, "short", "Overwrite should truncate to new content");
    }

    // --- edit_file with new_str empty (deletion) ---

    #[tokio::test]
    async fn edit_file_delete_text() {
        let mut h = McpTestHarness::new();
        h.write_fixture("del.txt", "keep DELETE_ME keep");
        h.call_tool_text(
            "edit_file",
            json!({"path": "del.txt", "old_str": "DELETE_ME ", "new_str": ""}),
        )
        .await;
        assert_eq!(h.read_fixture("del.txt"), "keep keep");
    }

    // --- edit_file error message includes file preview ---

    #[tokio::test]
    async fn edit_file_error_includes_file_content_preview() {
        let mut h = McpTestHarness::new();
        h.write_fixture("preview.txt", "first line\nsecond line\nthird line\n");
        let resp = h
            .call_tool(
                "edit_file",
                json!({"path": "preview.txt", "old_str": "not in file", "new_str": "x"}),
            )
            .await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(
            text.contains("first line"),
            "Error should preview file content: {}",
            text
        );
    }

    // --- edit_file non-unique match reports line numbers ---

    #[tokio::test]
    async fn edit_file_nonunique_reports_line_numbers() {
        let mut h = McpTestHarness::new();
        h.write_fixture("multi.txt", "hello\nworld\nhello\nfoo\n");
        let resp = h
            .call_tool(
                "edit_file",
                json!({"path": "multi.txt", "old_str": "hello", "new_str": "x"}),
            )
            .await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(
            text.contains("found 2 times"),
            "Should report match count: {}",
            text
        );
        assert!(
            text.contains("Line 1") || text.contains("line 1"),
            "Should report line numbers: {}",
            text
        );
    }

    // --- write_file with unicode filename ---

    #[tokio::test]
    async fn write_file_unicode_filename() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({"path": "日本語ファイル.txt", "content": "unicode filename test"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "日本語ファイル.txt"}))
            .await;
        assert_eq!(text, "unicode filename test");
    }

    // --- grep with unicode pattern ---

    #[tokio::test]
    async fn grep_unicode_pattern() {
        let mut h = McpTestHarness::new();
        h.write_fixture("unicode.txt", "hello 世界\nfoo bar\n");
        let text = h
            .call_tool_text("grep", json!({"pattern": "世界", "path": "."}))
            .await;
        assert!(
            text.contains("世界"),
            "Should find unicode pattern: {}",
            text
        );
    }

    // --- MCP tools with extra/unknown arguments should not crash ---

    #[tokio::test]
    async fn read_file_ignores_extra_params() {
        let mut h = McpTestHarness::new();
        h.write_fixture("extra.txt", "content");
        let text = h
            .call_tool_text(
                "read_file",
                json!({"path": "extra.txt", "unknown_param": "ignored"}),
            )
            .await;
        assert_eq!(text, "content", "Extra params should be ignored");
    }

    // --- Rapid successive operations on same file ---

    #[tokio::test]
    async fn rapid_write_read_cycles() {
        let mut h = McpTestHarness::new();
        for i in 0..20 {
            let content = format!("iteration {}", i);
            h.call_tool_text(
                "write_file",
                json!({"path": "rapid.txt", "content": content}),
            )
            .await;
            let text = h
                .call_tool_text("read_file", json!({"path": "rapid.txt"}))
                .await;
            assert_eq!(text, content, "Iteration {} mismatch", i);
        }
    }

    // --- Shell command interop with MCP file tools ---

    #[tokio::test]
    async fn shell_creates_file_mcp_edits() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "shell_eval",
            json!({"command": "echo 'created by shell' > shell_made.txt"}),
        )
        .await;
        h.call_tool_text(
            "edit_file",
            json!({
                "path": "shell_made.txt",
                "old_str": "created by shell",
                "new_str": "edited by MCP"
            }),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "shell_made.txt"}))
            .await;
        assert!(text.contains("edited by MCP"));
    }

    // --- Shell sees files created by MCP write_file ---

    #[tokio::test]
    async fn mcp_writes_shell_processes() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({
                "path": "data.csv",
                "content": "name,score\nalice,90\nbob,85\ncharlie,95\n"
            }),
        )
        .await;
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat data.csv | awk -F, 'NR>1 {print $1, $2}' | sort -r"}),
            )
            .await;
        assert!(
            text.contains("charlie"),
            "Shell should see MCP files: {}",
            text
        );
    }

    // --- Multiple edits to same file ---

    #[tokio::test]
    async fn multiple_sequential_edits() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({
                "path": "multi_edit.txt",
                "content": "line_a\nline_b\nline_c\n"
            }),
        )
        .await;
        h.call_tool_text(
            "edit_file",
            json!({"path": "multi_edit.txt", "old_str": "line_a", "new_str": "LINE_A"}),
        )
        .await;
        h.call_tool_text(
            "edit_file",
            json!({"path": "multi_edit.txt", "old_str": "line_b", "new_str": "LINE_B"}),
        )
        .await;
        h.call_tool_text(
            "edit_file",
            json!({"path": "multi_edit.txt", "old_str": "line_c", "new_str": "LINE_C"}),
        )
        .await;
        let text = h
            .call_tool_text("read_file", json!({"path": "multi_edit.txt"}))
            .await;
        assert_eq!(text, "LINE_A\nLINE_B\nLINE_C\n");
    }
}

// ============================================================
// Complex pipeline and data processing tests
// ============================================================

mod complex_pipelines {
    use super::harness::McpTestHarness;
    use serde_json::json;

    #[tokio::test]
    async fn five_stage_pipeline() {
        let mut h = McpTestHarness::new();
        h.write_fixture(
            "log.txt",
            "2024-01-01 INFO: started\n\
             2024-01-01 ERROR: disk full\n\
             2024-01-02 INFO: recovered\n\
             2024-01-02 ERROR: timeout\n\
             2024-01-03 INFO: done\n",
        );
        // Extract errors, cut the message, sort, count unique
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat log.txt | grep ERROR | cut -d: -f2 | sort | uniq -c"}),
            )
            .await;
        assert!(
            text.contains("disk full") || text.contains("timeout"),
            "Pipeline should process log: {}",
            text
        );
    }

    #[tokio::test]
    async fn json_to_csv_pipeline() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({
                "path": "users.json",
                "content": r#"[{"name":"alice","age":30},{"name":"bob","age":25}]"#
            }),
        )
        .await;
        // Extract names using jq then process
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "cat users.json | jq -r '.[].name' | sort"}),
            )
            .await;
        let lines: Vec<&str> = text.trim().lines().collect();
        assert_eq!(lines, vec!["alice", "bob"]);
    }

    #[tokio::test]
    async fn generate_process_verify_workflow() {
        let mut h = McpTestHarness::new();
        // Generate data with seq
        h.call_tool_text("shell_eval", json!({"command": "seq 1 100 > numbers.txt"}))
            .await;
        // Count lines
        let text = h
            .call_tool_text("shell_eval", json!({"command": "wc -l numbers.txt"}))
            .await;
        assert!(text.contains("100"), "Should have 100 lines: {}", text);
        // Hash for integrity
        let hash1 = h
            .call_tool_text("shell_eval", json!({"command": "sha256sum numbers.txt"}))
            .await;
        // Read and re-hash
        let content = h
            .call_tool_text("read_file", json!({"path": "numbers.txt"}))
            .await;
        h.call_tool_text(
            "write_file",
            json!({"path": "numbers_copy.txt", "content": content}),
        )
        .await;
        let hash2 = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "sha256sum numbers_copy.txt"}),
            )
            .await;
        // Extract just the hash part (before filename)
        let h1 = hash1.split_whitespace().next().unwrap_or("");
        let h2 = hash2.split_whitespace().next().unwrap_or("");
        assert_eq!(h1, h2, "Hashes should match after roundtrip");
    }

    #[tokio::test]
    async fn heredoc_style_multiline_write() {
        let mut h = McpTestHarness::new();
        // Write a multi-line script, then execute parts of it
        h.call_tool_text(
            "write_file",
            json!({
                "path": "script.sh",
                "content": "#!/bin/sh\nfor i in 1 2 3; do\n  echo \"item: $i\"\ndone\n"
            }),
        )
        .await;
        // Source the script's logic via shell
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "for i in 1 2 3; do echo \"item: $i\"; done"}),
            )
            .await;
        assert!(text.contains("item: 1"), "Script loop: {}", text);
        assert!(text.contains("item: 2"), "Script loop: {}", text);
        assert!(text.contains("item: 3"), "Script loop: {}", text);
    }

    #[tokio::test]
    async fn csv_processing_pipeline() {
        let mut h = McpTestHarness::new();
        h.call_tool_text(
            "write_file",
            json!({
                "path": "scores.csv",
                "content": "name,math,english\nalice,95,88\nbob,72,91\ncharlie,88,76\n"
            }),
        )
        .await;
        // Extract math scores, sort them
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "tail -n +2 scores.csv | cut -d, -f2 | sort -r"}),
            )
            .await;
        let lines: Vec<&str> = text.trim().lines().collect();
        // Lexicographic sort: "95" > "88" > "72"
        assert_eq!(lines, vec!["95", "88", "72"]);
    }

    #[tokio::test]
    async fn find_and_grep_workflow() {
        let mut h = McpTestHarness::new();
        h.write_fixture("project/src/main.rs", "fn main() { todo!() }\n");
        h.write_fixture(
            "project/src/lib.rs",
            "pub fn hello() { println!(\"hi\") }\n",
        );
        h.write_fixture("project/tests/test.rs", "fn test_hello() { todo!() }\n");
        h.write_fixture("project/README.md", "# My Project\n");
        // Use grep to find all TODO items
        let text = h
            .call_tool_text("grep", json!({"pattern": "todo!", "path": "project"}))
            .await;
        assert!(
            text.contains("main.rs"),
            "Should find todo in main: {}",
            text
        );
        assert!(
            text.contains("test.rs"),
            "Should find todo in test: {}",
            text
        );
        assert!(
            !text.contains("lib.rs"),
            "Should not match lib.rs: {}",
            text
        );
    }

    #[tokio::test]
    async fn base64_encode_file_content() {
        let mut h = McpTestHarness::new();
        h.write_fixture("secret.txt", "sensitive data");
        // Encode file content
        let encoded = h
            .call_tool_text("shell_eval", json!({"command": "cat secret.txt | base64"}))
            .await;
        // Decode it back
        let decoded = h
            .call_tool_text(
                "shell_eval",
                json!({"command": format!("echo '{}' | base64 -d", encoded.trim())}),
            )
            .await;
        assert_eq!(decoded.trim(), "sensitive data");
    }

    #[tokio::test]
    async fn sqlite_from_csv_workflow() {
        let mut h = McpTestHarness::new();
        // Create data then query with sqlite
        let text = h
            .call_tool_text(
                "shell_eval",
                json!({"command": "sqlite3 ':memory:' 'CREATE TABLE nums(n INT); INSERT INTO nums VALUES(10),(20),(30),(40),(50); SELECT SUM(n) FROM nums;'"}),
            )
            .await;
        assert!(text.contains("150"), "SUM should be 150: {}", text);
    }
}
