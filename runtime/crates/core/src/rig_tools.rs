//! Rig-Core Tool Adapters
//!
//! Adapters to use MCP tools with rig-core's Agent abstraction.
//! These implement rig-core's `ToolDyn` trait for dynamic tool dispatch.
//!
//! Uses the [`McpTransport`] trait to abstract over MCP backends.

use rig::completion::ToolDefinition as RigToolDefinition;
use rig::tool::{ToolDyn, ToolError};
use rig::wasm_compat::WasmBoxedFuture;
use serde_json::Value;
use std::sync::Arc;

use crate::mcp_transport::{McpTransport, ToolDefinition as McpToolDefinition};

/// Wrapper for an MCP tool that implements rig-core's `ToolDyn` trait.
///
/// This allows MCP tools to be used with rig-core's `Agent` abstraction.
/// Uses the [`McpTransport`] trait so it works with any MCP backend.
pub struct McpToolAdapter<T: McpTransport> {
    /// Tool definition from MCP
    definition: McpToolDefinition,
    /// Shared reference to the MCP transport for making calls
    transport: Arc<T>,
}

impl<T: McpTransport + 'static> McpToolAdapter<T> {
    /// Create a new MCP tool adapter
    pub fn new(definition: McpToolDefinition, transport: Arc<T>) -> Self {
        Self {
            definition,
            transport,
        }
    }

    /// Create adapters for all tools from an MCP transport
    pub fn from_transport(transport: Arc<T>) -> Result<Vec<Self>, String> {
        let tools = transport.list_tools().map_err(|e| e.to_string())?;
        Ok(tools
            .into_iter()
            .map(|def| Self::new(def, transport.clone()))
            .collect())
    }
}

impl<T: McpTransport + 'static> ToolDyn for McpToolAdapter<T> {
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
        let transport = self.transport.clone();
        let tool_name = self.definition.name.clone();

        Box::pin(async move {
            // Parse the JSON arguments
            let args_value: Value = serde_json::from_str(&args)?;

            // Call the MCP tool via the transport trait
            let result = transport
                .call_tool(&tool_name, args_value)
                .map_err(|e| ToolError::ToolCallError(e.to_string().into()))?;

            Ok(result)
        })
    }
}

/// Build a rig-core `ToolSet` from an MCP transport
///
/// This creates adapters for all tools available from the MCP transport.
/// Local tools can be added by the caller using ToolSet::add_tool().
pub fn build_tool_set<T: McpTransport + 'static>(
    transport: Arc<T>,
) -> Result<rig::tool::ToolSet, String> {
    let mut tool_set = rig::tool::ToolSet::default();

    // Add MCP tools
    for tool in McpToolAdapter::from_transport(transport)? {
        tool_set.add_tool(tool);
    }

    Ok(tool_set)
}

#[cfg(test)]
mod tests {
    // Tests require a mock McpTransport implementation
}
