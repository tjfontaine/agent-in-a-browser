//! Rig-Core Tool Adapters
//!
//! Adapters to use our existing MCP tools with rig-core's Agent abstraction.
//! These implement rig-core's `ToolDyn` trait for dynamic tool dispatch.

use rig::completion::ToolDefinition as RigToolDefinition;
use rig::tool::{ToolDyn, ToolError};
use rig::wasm_compat::WasmBoxedFuture;
use serde_json::Value;

use super::mcp_client::{McpClient, ToolDefinition as McpToolDefinition};

/// Wrapper for an MCP tool that implements rig-core's `ToolDyn` trait.
///
/// This allows MCP tools to be used with rig-core's `Agent` abstraction.
/// The McpClient is thread-safe (Arc<Mutex>) so this adapter is Send + Sync.
pub struct McpToolAdapter {
    /// Tool definition from MCP
    definition: McpToolDefinition,
    /// Shared reference to the MCP client for making calls
    client: McpClient,
}

impl McpToolAdapter {
    /// Create a new MCP tool adapter
    pub fn new(definition: McpToolDefinition, client: McpClient) -> Self {
        Self { definition, client }
    }

    /// Create adapters for all tools from an MCP client
    pub fn from_mcp_client(client: &McpClient) -> Result<Vec<Self>, String> {
        let tools = client.list_tools().map_err(|e| e.to_string())?;
        Ok(tools
            .into_iter()
            .map(|def| Self::new(def, client.clone()))
            .collect())
    }
}

impl ToolDyn for McpToolAdapter {
    fn name(&self) -> String {
        self.definition.name.clone()
    }

    fn definition<'a>(&'a self, _prompt: String) -> WasmBoxedFuture<'a, RigToolDefinition> {
        let name = self.definition.name.clone();
        let description = self.definition.description.clone();
        let parameters = self.definition.input_schema.clone();

        Box::pin(async move {
            RigToolDefinition {
                name,
                description,
                parameters,
            }
        })
    }

    fn call<'a>(&'a self, args: String) -> WasmBoxedFuture<'a, Result<String, ToolError>> {
        let client = self.client.clone();
        let tool_name = self.definition.name.clone();

        Box::pin(async move {
            // Parse the JSON arguments
            let args_value: Value = serde_json::from_str(&args)?;

            // Call the MCP tool
            let result = client
                .call_tool(&tool_name, args_value)
                .map_err(|e| ToolError::ToolCallError(e.to_string().into()))?;

            Ok(result)
        })
    }
}

/// Wrapper for local tools that implement rig-core's `ToolDyn` trait.
///
/// Local tools don't need network calls - they update UI state directly.
pub struct LocalToolAdapter {
    /// Tool definition
    definition: McpToolDefinition,
}

impl LocalToolAdapter {
    /// Create adapter for task_write tool
    pub fn task_write_tool() -> Self {
        let definitions = super::local_tools::get_local_tool_definitions();
        let def = definitions
            .into_iter()
            .find(|d| d.name == "task_write")
            .expect("task_write tool definition should exist");

        Self { definition: def }
    }

    /// Get all local tool adapters
    pub fn all_local_tools() -> Vec<Self> {
        super::local_tools::get_local_tool_definitions()
            .into_iter()
            .map(|def| Self { definition: def })
            .collect()
    }
}

impl ToolDyn for LocalToolAdapter {
    fn name(&self) -> String {
        self.definition.name.clone()
    }

    fn definition<'a>(&'a self, _prompt: String) -> WasmBoxedFuture<'a, RigToolDefinition> {
        let name = self.definition.name.clone();
        let description = self.definition.description.clone();
        let parameters = self.definition.input_schema.clone();

        Box::pin(async move {
            RigToolDefinition {
                name,
                description,
                parameters,
            }
        })
    }

    fn call<'a>(&'a self, args: String) -> WasmBoxedFuture<'a, Result<String, ToolError>> {
        let tool_name = self.definition.name.clone();

        Box::pin(async move {
            // Parse the JSON arguments
            let args_value: Value = serde_json::from_str(&args)?;

            // Try to execute as local tool
            match super::local_tools::try_execute_local_tool(&tool_name, args_value) {
                Some(result) => {
                    if result.success {
                        // For task_write, also return the tasks as JSON so the agent knows what happened
                        if let Some(tasks) = result.tasks {
                            Ok(serde_json::to_string(&serde_json::json!({
                                "success": true,
                                "message": result.message,
                                "tasks": tasks
                            }))
                            .unwrap_or(result.message))
                        } else {
                            Ok(result.message)
                        }
                    } else {
                        Err(ToolError::ToolCallError(result.message.into()))
                    }
                }
                None => Err(ToolError::ToolCallError(
                    format!("Tool not found: {}", tool_name).into(),
                )),
            }
        })
    }
}

/// Build a rig-core `ToolSet` from MCP and local tools
pub fn build_tool_set(mcp_client: &McpClient) -> Result<rig::tool::ToolSet, String> {
    let mut tool_set = rig::tool::ToolSet::default();

    // Add MCP tools
    for tool in McpToolAdapter::from_mcp_client(mcp_client)? {
        tool_set.add_tool(tool);
    }

    // Add local tools
    for tool in LocalToolAdapter::all_local_tools() {
        tool_set.add_tool(tool);
    }

    Ok(tool_set)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_tool_adapter_creation() {
        let adapter = LocalToolAdapter::task_write_tool();
        assert_eq!(adapter.name(), "task_write");
    }

    #[test]
    fn test_all_local_tools() {
        let tools = LocalToolAdapter::all_local_tools();
        assert!(!tools.is_empty());
        assert!(tools.iter().any(|t| t.name() == "task_write"));
    }
}
