//! Server Management
//!
//! Handles MCP server connections, tool collection, and routing.

use crate::bridge::http_client::HttpClient;
use crate::bridge::local_tools::{format_tasks_for_display, try_execute_local_tool, Task};
use crate::bridge::mcp_client::{McpError, ToolDefinition};
use crate::ui::{AuxContent, AuxContentKind};
use agent_bridge::RemoteMcpClient;
use serde_json::Value;

/// Remote server connection status
#[derive(Clone, PartialEq, Debug)]
pub enum ServerConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    AuthRequired,
    Error(String),
}

impl std::fmt::Display for ServerConnectionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServerConnectionStatus::Disconnected => write!(f, "disconnected"),
            ServerConnectionStatus::Connecting => write!(f, "connecting"),
            ServerConnectionStatus::Connected => write!(f, "connected"),
            ServerConnectionStatus::AuthRequired => write!(f, "auth required"),
            ServerConnectionStatus::Error(msg) => write!(f, "error: {}", msg),
        }
    }
}

/// A remote MCP server entry
#[derive(Clone)]
pub struct RemoteServerEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    pub status: ServerConnectionStatus,
    pub tools: Vec<ToolDefinition>,
    pub bearer_token: Option<String>,
}

/// Results from tool execution including optional task updates
pub struct ToolExecutionResult {
    pub output: Result<String, String>,
    pub tasks: Option<Vec<Task>>,
    pub aux_update: Option<AuxContent>,
    /// If true, LLM is requesting to transition from planning to execution
    pub request_execution: bool,
}

/// Tool routing logic for multi-server MCP architecture
pub struct ToolRouter;

impl ToolRouter {
    /// Route a tool call to the correct server based on prefix
    ///
    /// Reserved prefixes (double underscore):
    /// - `__sandbox__` : Built-in sandbox MCP tools (read_file, write_file, etc.)
    /// - `__local__`   : Client-local tools (task_write, etc.)
    ///
    /// User-defined MCP servers use their server_id as prefix (cannot start with __)
    pub fn route_tool_call<F>(
        prefixed_name: &str,
        args: Value,
        call_sandbox_tool: F,
    ) -> ToolExecutionResult
    where
        F: FnOnce(&str, Value) -> Result<String, String>,
    {
        // 1. Check for __local__ prefix (client-side tools)
        if let Some(tool_name) = prefixed_name.strip_prefix("__local__") {
            if let Some(result) = try_execute_local_tool(tool_name, args) {
                let aux_update = result.tasks.as_ref().map(|tasks| AuxContent {
                    kind: AuxContentKind::TaskList,
                    title: "Tasks".to_string(),
                    content: format_tasks_for_display(tasks),
                });

                return ToolExecutionResult {
                    output: if result.success {
                        Ok(result.message)
                    } else {
                        Err(result.message)
                    },
                    tasks: result.tasks,
                    aux_update,
                    request_execution: result.request_execution,
                };
            }
            return ToolExecutionResult {
                output: Err(format!("Unknown local tool: {}", tool_name)),
                tasks: None,
                aux_update: None,
                request_execution: false,
            };
        }

        // 2. Check for __sandbox__ prefix (built-in MCP tools)
        if let Some(tool_name) = prefixed_name.strip_prefix("__sandbox__") {
            return ToolExecutionResult {
                output: call_sandbox_tool(tool_name, args),
                tasks: None,
                aux_update: None,
                request_execution: false,
            };
        }

        // 3. Parse user-defined server prefix (server_id_toolname)
        if let Some(pos) = prefixed_name.find('_') {
            let (server_id, _tool_name) = prefixed_name.split_at(pos);

            // Block double-underscore prefixes for user servers
            if server_id.starts_with('_') {
                return ToolExecutionResult {
                    output: Err(format!(
                        "Server ID cannot start with underscore (reserved): {}",
                        server_id
                    )),
                    tasks: None,
                    aux_update: None,
                    request_execution: false,
                };
            }

            // Route to remote server (TODO: implement remote MCP client)
            return ToolExecutionResult {
                output: Err(format!(
                    "Remote server '{}' tool calls not yet implemented",
                    server_id
                )),
                tasks: None,
                aux_update: None,
                request_execution: false,
            };
        }

        ToolExecutionResult {
            output: Err(format!("Unknown tool: {}", prefixed_name)),
            tasks: None,
            aux_update: None,
            request_execution: false,
        }
    }

    /// Format a prefixed tool name for user-friendly display
    ///
    /// - Built-in tools (__sandbox__, __local__): Show just the tool name
    /// - Remote servers: Show "server → tool" format
    pub fn format_tool_for_display(prefixed_name: &str) -> String {
        // Hide prefix for built-in tools
        if let Some(tool_name) = prefixed_name.strip_prefix("__sandbox__") {
            return tool_name.to_string();
        }
        if let Some(tool_name) = prefixed_name.strip_prefix("__local__") {
            return tool_name.to_string();
        }

        // For remote servers, show "server → tool" format
        if let Some(pos) = prefixed_name.find('_') {
            let (server_id, tool_name) = prefixed_name.split_at(pos);
            let tool_name = &tool_name[1..]; // Skip the underscore
                                             // Don't format if server_id looks like a reserved prefix
            if !server_id.starts_with('_') {
                return format!("{} → {}", server_id, tool_name);
            }
        }

        // Fallback: return as-is
        prefixed_name.to_string()
    }
}

/// Server entry management functions
pub struct ServerManager;

impl ServerManager {
    /// Add a new remote server entry. Returns true if added, false if already exists.
    pub fn add_server(servers: &mut Vec<RemoteServerEntry>, url: &str) -> bool {
        // Normalize URL: trim, ensure https:// prefix, remove trailing slash
        let url = url.trim();
        let url = if url.starts_with("http://") || url.starts_with("https://") {
            url.trim_end_matches('/').to_string()
        } else {
            format!("https://{}", url.trim_end_matches('/'))
        };

        // Generate ID from URL
        let id = url
            .replace("https://", "")
            .replace("http://", "")
            .replace('/', "-")
            .replace('.', "-");

        // Check if already exists
        if servers.iter().any(|s| s.url == url) {
            return false;
        }

        let name = url
            .replace("https://", "")
            .replace("http://", "")
            .split('/')
            .next()
            .unwrap_or(&url)
            .to_string();

        let entry = RemoteServerEntry {
            id,
            name,
            url,
            status: ServerConnectionStatus::Disconnected,
            tools: Vec::new(),
            bearer_token: None,
        };

        servers.push(entry);
        true
    }

    /// Remove a remote server by ID
    pub fn remove_server(servers: &mut Vec<RemoteServerEntry>, id: &str) {
        servers.retain(|s| s.id != id);
    }

    /// Set bearer token for a server
    pub fn set_token(servers: &mut [RemoteServerEntry], id: &str, token: &str) {
        if let Some(server) = servers.iter_mut().find(|s| s.id == id) {
            server.bearer_token = Some(token.to_string());
        }
    }

    /// Connect to a remote MCP server
    ///
    /// Performs MCP 2025-11-25 initialization handshake and fetches tools.
    pub fn connect_server(server: &RemoteServerEntry) -> Result<Vec<ToolDefinition>, McpError> {
        // Normalize URL: ensure https:// prefix
        let url = if server.url.starts_with("http://") || server.url.starts_with("https://") {
            server.url.clone()
        } else {
            format!("https://{}", server.url)
        };
        let mut client = RemoteMcpClient::new(HttpClient, &url, server.bearer_token.clone());
        client.connect()
    }

    /// Toggle server connection state
    pub fn toggle_connection(servers: &mut [RemoteServerEntry], id: &str) {
        if let Some(server) = servers.iter_mut().find(|s| s.id == id) {
            match server.status {
                ServerConnectionStatus::Connected => {
                    server.status = ServerConnectionStatus::Disconnected;
                    server.tools.clear();
                }
                _ => {
                    // Mark as connecting - actual connection happens in app layer
                    server.status = ServerConnectionStatus::Connecting;
                }
            }
        }
    }
}

/// Tool collection logic
pub struct ToolCollector;

impl ToolCollector {
    /// Collect all tools with server prefixes for multi-server routing
    pub fn collect_all_tools<F>(
        remote_servers: &[RemoteServerEntry],
        list_sandbox_tools: F,
    ) -> (Vec<ToolDefinition>, bool, usize)
    where
        F: FnOnce() -> Result<Vec<ToolDefinition>, String>,
    {
        let mut all_tools = Vec::new();
        let local_connected;
        let mut local_tool_count = 0;

        // 1. Sandbox tools (prefix: "__sandbox__")
        match list_sandbox_tools() {
            Ok(sandbox_tools) => {
                local_connected = true;
                local_tool_count = sandbox_tools.len();
                for tool in sandbox_tools {
                    all_tools.push(ToolDefinition {
                        name: format!("__sandbox__{}", tool.name),
                        description: tool.description,
                        input_schema: tool.input_schema,
                        title: tool.title,
                    });
                }
            }
            Err(_) => {
                local_connected = false;
            }
        }

        // 2. Remote server tools (prefix: "<server_id>_")
        for server in remote_servers {
            if server.status == ServerConnectionStatus::Connected {
                for tool in &server.tools {
                    all_tools.push(ToolDefinition {
                        name: format!("{}_{}", server.id, tool.name),
                        description: tool.description.clone(),
                        input_schema: tool.input_schema.clone(),
                        title: tool.title.clone(),
                    });
                }
            }
        }

        // 3. Local tools (prefix: "__local__")
        for tool in crate::bridge::local_tools::get_local_tool_definitions() {
            all_tools.push(ToolDefinition {
                name: format!("__local__{}", tool.name),
                description: tool.description,
                input_schema: tool.input_schema,
                title: tool.title,
            });
        }

        (all_tools, local_connected, local_tool_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_router_local_task_write() {
        let args = serde_json::json!({
            "tasks": [
                { "id": "1", "content": "Test step", "status": "pending" }
            ]
        });

        let result = ToolRouter::route_tool_call("__local__task_write", args, |_, _| {
            Err("should not call sandbox".into())
        });

        assert!(result.output.is_ok());
        assert!(!result.request_execution);
        assert!(result.tasks.is_some());
    }

    #[test]
    fn test_tool_router_local_request_execution() {
        let args = serde_json::json!({
            "summary": "Add dark mode feature"
        });

        let result = ToolRouter::route_tool_call("__local__request_execution", args, |_, _| {
            Err("should not call sandbox".into())
        });

        assert!(result.output.is_ok());
        assert!(result.request_execution);
        assert!(result.output.unwrap().contains("Add dark mode feature"));
    }

    #[test]
    fn test_tool_router_request_execution_missing_summary() {
        let args = serde_json::json!({});

        let result = ToolRouter::route_tool_call("__local__request_execution", args, |_, _| {
            Err("should not call sandbox".into())
        });

        assert!(result.output.is_err());
        assert!(!result.request_execution);
    }

    #[test]
    fn test_tool_router_task_write_single_in_progress() {
        let args = serde_json::json!({
            "tasks": [
                { "id": "1", "content": "Step 1", "status": "in_progress" },
                { "id": "2", "content": "Step 2", "status": "in_progress" }
            ]
        });

        let result = ToolRouter::route_tool_call("__local__task_write", args, |_, _| {
            Err("should not call sandbox".into())
        });

        assert!(result.output.is_err());
        assert!(result.output.unwrap_err().contains("Only one step"));
    }

    #[test]
    fn test_tool_router_sandbox_tool() {
        let args = serde_json::json!({ "path": "/test" });

        let result = ToolRouter::route_tool_call("__sandbox__read_file", args, |name, _| {
            assert_eq!(name, "read_file");
            Ok("file contents".into())
        });

        assert!(result.output.is_ok());
        assert!(!result.request_execution);
        assert!(result.tasks.is_none());
    }

    #[test]
    fn test_tool_router_unknown_local_tool() {
        let args = serde_json::json!({});

        let result = ToolRouter::route_tool_call("__local__nonexistent", args, |_, _| {
            Err("should not call sandbox".into())
        });

        assert!(result.output.is_err());
        assert!(result.output.unwrap_err().contains("Unknown local tool"));
    }

    #[test]
    fn test_format_tool_for_display_local() {
        assert_eq!(
            ToolRouter::format_tool_for_display("__local__task_write"),
            "task_write"
        );
        assert_eq!(
            ToolRouter::format_tool_for_display("__local__request_execution"),
            "request_execution"
        );
    }

    #[test]
    fn test_format_tool_for_display_sandbox() {
        assert_eq!(
            ToolRouter::format_tool_for_display("__sandbox__read_file"),
            "read_file"
        );
    }

    #[test]
    fn test_format_tool_for_display_remote() {
        // Remote server tools use IDs derived from URLs
        // (dots and slashes become hyphens, so weather.api.com → weather-api-com)
        assert_eq!(
            ToolRouter::format_tool_for_display("weather-api-com_get_forecast"),
            "weather-api-com → get_forecast"
        );
        assert_eq!(
            ToolRouter::format_tool_for_display("github-com-api_list_repos"),
            "github-com-api → list_repos"
        );
    }

    // === ServerManager Tests ===

    #[test]
    fn test_add_server_normalizes_url() {
        let mut servers = Vec::new();

        // Should add https:// prefix
        assert!(ServerManager::add_server(&mut servers, "example.com/mcp"));
        assert_eq!(servers[0].url, "https://example.com/mcp");

        // Should remove trailing slash
        servers.clear();
        assert!(ServerManager::add_server(
            &mut servers,
            "https://example.com/"
        ));
        assert_eq!(servers[0].url, "https://example.com");
    }

    #[test]
    fn test_add_server_generates_id() {
        let mut servers = Vec::new();
        ServerManager::add_server(&mut servers, "https://api.example.com/mcp");

        // ID should be derived from URL
        assert!(!servers[0].id.is_empty());
        assert!(servers[0].id.contains("api-example-com"));
    }

    #[test]
    fn test_add_server_rejects_duplicate() {
        let mut servers = Vec::new();

        assert!(ServerManager::add_server(
            &mut servers,
            "https://example.com"
        ));
        // Same URL should be rejected
        assert!(!ServerManager::add_server(
            &mut servers,
            "https://example.com"
        ));
        assert_eq!(servers.len(), 1);
    }

    #[test]
    fn test_remove_server() {
        let mut servers = Vec::new();
        ServerManager::add_server(&mut servers, "https://example.com");
        let id = servers[0].id.clone();

        ServerManager::remove_server(&mut servers, &id);
        assert!(servers.is_empty());
    }

    #[test]
    fn test_set_token() {
        let mut servers = Vec::new();
        ServerManager::add_server(&mut servers, "https://example.com");
        let id = servers[0].id.clone();

        ServerManager::set_token(&mut servers, &id, "my-secret-token");
        assert_eq!(servers[0].bearer_token, Some("my-secret-token".to_string()));
    }

    #[test]
    fn test_toggle_connection_disconnected_to_connecting() {
        let mut servers = Vec::new();
        ServerManager::add_server(&mut servers, "https://example.com");
        let id = servers[0].id.clone();

        assert_eq!(servers[0].status, ServerConnectionStatus::Disconnected);
        ServerManager::toggle_connection(&mut servers, &id);
        assert_eq!(servers[0].status, ServerConnectionStatus::Connecting);
    }

    #[test]
    fn test_toggle_connection_connected_to_disconnected() {
        let mut servers = vec![RemoteServerEntry {
            id: "test".to_string(),
            name: "Test".to_string(),
            url: "https://example.com".to_string(),
            status: ServerConnectionStatus::Connected,
            tools: vec![],
            bearer_token: None,
        }];

        ServerManager::toggle_connection(&mut servers, "test");
        assert_eq!(servers[0].status, ServerConnectionStatus::Disconnected);
    }

    // === ToolCollector Tests ===

    #[test]
    fn test_collect_all_tools_prefixes_sandbox() {
        let remote_servers = vec![];

        // Mock sandbox tool list
        let (tools, connected, count) = ToolCollector::collect_all_tools(&remote_servers, || {
            Ok(vec![crate::bridge::mcp_client::ToolDefinition {
                name: "read_file".to_string(),
                description: "Read a file".to_string(),
                input_schema: serde_json::json!({}),
                title: None,
            }])
        });

        assert!(connected);
        assert_eq!(count, 1);
        assert!(tools.iter().any(|t| t.name == "__sandbox__read_file"));
    }

    #[test]
    fn test_collect_all_tools_includes_local() {
        let remote_servers = vec![];

        let (tools, _, _) = ToolCollector::collect_all_tools(&remote_servers, || Ok(vec![]));

        // Should include local tools with __local__ prefix
        assert!(tools.iter().any(|t| t.name.starts_with("__local__")));
    }

    #[test]
    fn test_collect_all_tools_includes_remote() {
        let remote_servers = vec![RemoteServerEntry {
            id: "weather".to_string(),
            name: "Weather".to_string(),
            url: "https://weather.example.com".to_string(),
            status: ServerConnectionStatus::Connected,
            tools: vec![crate::bridge::mcp_client::ToolDefinition {
                name: "get_forecast".to_string(),
                description: "Get weather forecast".to_string(),
                input_schema: serde_json::json!({}),
                title: None,
            }],
            bearer_token: None,
        }];

        let (tools, _, _) = ToolCollector::collect_all_tools(&remote_servers, || Ok(vec![]));

        // Should include remote tool with server prefix
        assert!(tools.iter().any(|t| t.name == "weather_get_forecast"));
    }

    // === ServerConnectionStatus Display Tests ===

    #[test]
    fn test_server_connection_status_display() {
        assert_eq!(
            format!("{}", ServerConnectionStatus::Disconnected),
            "disconnected"
        );
        assert_eq!(
            format!("{}", ServerConnectionStatus::Connecting),
            "connecting"
        );
        assert_eq!(
            format!("{}", ServerConnectionStatus::Connected),
            "connected"
        );
        assert_eq!(
            format!("{}", ServerConnectionStatus::AuthRequired),
            "auth required"
        );
        assert_eq!(
            format!("{}", ServerConnectionStatus::Error("timeout".to_string())),
            "error: timeout"
        );
    }
}
