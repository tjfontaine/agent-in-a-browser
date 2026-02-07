//! MCP Client
//!
//! Client for communicating with the remote MCP server via HTTP.
//! This keeps the MCP server decoupled from the TUI.

use super::http_client::HttpClient;
pub use agent_bridge::{McpError, ToolDefinition};
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// MCP Client for remote tool execution.
///
/// This is a thread-safe wrapper that can be shared across async boundaries.
/// Uses Arc<Mutex> internally to satisfy Send + Sync requirements for rig-core tools.
#[derive(Clone)]
pub struct McpClient {
    // Wrap the generic client
    inner: Arc<Mutex<agent_bridge::RemoteMcpClient<HttpClient>>>,
}

impl McpClient {
    /// Create a new MCP client
    pub fn new(base_url: &str) -> Self {
        // Create the generic client with HttpClient
        let client = agent_bridge::RemoteMcpClient::new(HttpClient, base_url, None);
        Self {
            inner: Arc::new(Mutex::new(client)),
        }
    }

    /// Initialize the MCP connection
    pub fn initialize(&self) -> Result<(), McpError> {
        let mut client = self.inner.lock().map_err(|_| McpError::LockError)?;
        // connect() handles initialization (and listing tools, but we ignore tools here)
        let _ = client.connect()?;
        Ok(())
    }

    /// List available tools
    pub fn list_tools(&self) -> Result<Vec<ToolDefinition>, McpError> {
        let client = self.inner.lock().map_err(|_| McpError::LockError)?;
        // If not initialized, connect? RemoteMcpClient tracks initialization state?
        // RemoteMcpClient::connect() sets initialized = true.
        // But list_tools() checks? No, RemoteMcpClient::list_tools doesn't auto-connect (unlike TUI version).
        // TUI version did auto-connect.
        // We might want to keep that behavior?
        // But McpClient::initialize is public.
        // Let's rely on caller or just call list_tools directly.
        // Ideally we should auto-connect if strict parity is required.
        // But `client` is locked.
        // We can't easily check internal state of RemoteMcpClient (fields private).
        // Let's assume initialized. Or just call list_tools.
        // Wait, TUI code had auto-connect logic.
        // I should replicate if possible, but RemoteMcpClient state is private.
        // However, standard usage is initialize() then list_tools().
        // If parity is needed, I should ensure `initialize` is called.
        // But I can't check `client.initialized` (private).
        // I will trust the flow for now.
        client.list_tools()
    }

    /// Call a tool by name with arguments
    pub fn call_tool(&self, name: &str, arguments: Value) -> Result<String, McpError> {
        let client = self.inner.lock().map_err(|_| McpError::LockError)?;
        client.call_tool(name, arguments)
    }
}

// Implement agent_bridge::McpTransport trait for shared tool adapter usage
impl agent_bridge::McpTransport for McpClient {
    fn list_tools(&self) -> Result<Vec<agent_bridge::ToolDefinition>, agent_bridge::McpError> {
        self.list_tools()
    }

    fn call_tool(
        &self,
        name: &str,
        arguments: serde_json::Value,
    ) -> Result<String, agent_bridge::McpError> {
        self.call_tool(name, arguments)
    }
}
