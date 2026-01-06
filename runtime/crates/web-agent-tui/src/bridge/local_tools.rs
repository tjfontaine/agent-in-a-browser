//! Client-local tools for TUI
//!
//! Re-exports from agent_bridge for backwards compatibility.

pub use agent_bridge::{
    format_tasks_for_display, get_local_tool_definitions, try_execute_local_tool,
    LocalToolDefinition, LocalToolResult, Task, TaskStatus,
};

// Re-export ToolDefinition as McpToolDefinition for compatibility with existing code
pub use crate::bridge::mcp_client::ToolDefinition;
