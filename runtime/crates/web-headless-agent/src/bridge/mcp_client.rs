//! MCP Client
//!
//! Client for communicating with the remote MCP server via HTTP.
//! This keeps the MCP server decoupled from the TUI.

use super::http_client::{HttpClient, HttpError};
use agent_bridge::McpTransport;
pub use agent_bridge::{McpError, ToolContent, ToolDefinition, ToolResult};
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// MCP Client for remote tool execution (Sandbox)
#[derive(Clone)]
pub struct SandboxMcpClient {
    // Wrap the generic client
    inner: Arc<Mutex<agent_bridge::RemoteMcpClient<HttpClient>>>,
}

impl SandboxMcpClient {
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
        client.list_tools()
    }

    /// Call a tool by name with arguments
    pub fn call_tool(&self, name: &str, arguments: Value) -> Result<String, McpError> {
        let client = self.inner.lock().map_err(|_| McpError::LockError)?;
        client.call_tool(name, arguments)
    }
}

// Implement agent_bridge::McpTransport trait for shared tool adapter usage
impl agent_bridge::McpTransport for SandboxMcpClient {
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
