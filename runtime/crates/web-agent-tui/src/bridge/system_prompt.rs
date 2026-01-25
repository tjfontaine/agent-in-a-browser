//! System prompt for the AI agent
//!
//! Prompts are stored as embedded markdown resources for maintainability.
//! The prompt is dynamically augmented with available MCP servers and tools.

use crate::bridge::mcp_client::ToolDefinition;

/// Base system prompt (embedded from SYSTEM_PROMPT.md)
pub const SYSTEM_PROMPT: &str = include_str!("SYSTEM_PROMPT.md");

/// Plan mode system prompt addition (embedded from PLAN_MODE.md)
pub const PLAN_MODE_SYSTEM_PROMPT: &str = include_str!("PLAN_MODE.md");

/// Generate dynamic tool list section for system prompt
fn format_tool_list(tools: &[ToolDefinition]) -> String {
    if tools.is_empty() {
        return String::new();
    }

    let mut output = String::new();
    output.push_str("\n# Connected MCP Servers and Tools\n\n");

    // Group tools by prefix (server)
    let mut sandbox_tools = Vec::new();
    let mut local_tools = Vec::new();
    let mut server_tools: std::collections::HashMap<String, Vec<&ToolDefinition>> =
        std::collections::HashMap::new();

    for tool in tools {
        if let Some(name) = tool.name.strip_prefix("__sandbox__") {
            sandbox_tools.push((name, tool));
        } else if let Some(name) = tool.name.strip_prefix("__local__") {
            local_tools.push((name, tool));
        } else if let Some(pos) = tool.name.find('_') {
            let (server_id, _) = tool.name.split_at(pos);
            server_tools
                .entry(server_id.to_string())
                .or_default()
                .push(tool);
        }
    }

    // Sandbox tools
    if !sandbox_tools.is_empty() {
        output.push_str("## Sandbox Tools (__sandbox__)\n");
        output.push_str("Core tools for file operations, shell, and code execution.\n\n");
        output.push_str("| Tool | Description |\n");
        output.push_str("|------|-------------|\n");
        for (name, tool) in &sandbox_tools {
            // Truncate description to ~60 chars for table readability
            let desc = if tool.description.len() > 60 {
                format!("{}...", &tool.description[..57])
            } else {
                tool.description.clone()
            };
            output.push_str(&format!("| `__sandbox__{}` | {} |\n", name, desc));
        }
        output.push('\n');
    }

    // Local tools
    if !local_tools.is_empty() {
        output.push_str("## Local Tools (__local__)\n");
        output.push_str("Client-side tools that run in the TUI.\n\n");
        output.push_str("| Tool | Description |\n");
        output.push_str("|------|-------------|\n");
        for (name, tool) in &local_tools {
            let desc = if tool.description.len() > 60 {
                format!("{}...", &tool.description[..57])
            } else {
                tool.description.clone()
            };
            output.push_str(&format!("| `__local__{}` | {} |\n", name, desc));
        }
        output.push('\n');
    }

    // Remote server tools
    for (server_id, tools) in &server_tools {
        output.push_str(&format!("## {} Server\n", server_id));
        output.push_str(&format!(
            "Tools from connected MCP server '{}'.\n\n",
            server_id
        ));
        output.push_str("| Tool | Description |\n");
        output.push_str("|------|-------------|\n");
        for tool in tools {
            let desc = if tool.description.len() > 60 {
                format!("{}...", &tool.description[..57])
            } else {
                tool.description.clone()
            };
            output.push_str(&format!("| `{}` | {} |\n", tool.name, desc));
        }
        output.push('\n');
    }

    output
}

/// Get the system prompt message with dynamic tool list
pub fn get_system_message(tools: &[ToolDefinition]) -> SystemMessage {
    let tool_list = format_tool_list(tools);
    let prompt = format!("{}\n{}", SYSTEM_PROMPT, tool_list);
    SystemMessage { content: prompt }
}

/// Get system message with plan mode addition if in plan mode
pub fn get_system_message_for_mode(is_plan_mode: bool, tools: &[ToolDefinition]) -> SystemMessage {
    let tool_list = format_tool_list(tools);
    if is_plan_mode {
        let prompt = format!(
            "{}\n{}\n{}",
            SYSTEM_PROMPT, tool_list, PLAN_MODE_SYSTEM_PROMPT
        );
        SystemMessage { content: prompt }
    } else {
        let prompt = format!("{}\n{}", SYSTEM_PROMPT, tool_list);
        SystemMessage { content: prompt }
    }
}

/// Simple system message struct
pub struct SystemMessage {
    pub content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_system_message_for_mode_agent() {
        let tools = vec![];
        let message = get_system_message_for_mode(false, &tools);

        // Should contain base prompt
        assert!(message.content.contains("You are a helpful AI assistant"));
        // Should NOT contain plan mode prompt
        assert!(!message.content.contains("PLAN MODE ACTIVE"));
    }

    #[test]
    fn test_get_system_message_for_mode_plan() {
        let tools = vec![];
        let message = get_system_message_for_mode(true, &tools);

        // Should contain base prompt AND plan mode prompt
        assert!(message.content.contains("You are a helpful AI assistant"));
        assert!(message.content.contains("PLAN MODE ACTIVE"));
    }

    #[test]
    fn test_get_system_message_includes_tools() {
        let tools = vec![ToolDefinition {
            name: "__sandbox__read_file".to_string(),
            description: "Read a file from the filesystem".to_string(),
            input_schema: serde_json::json!({}),
            title: None,
        }];

        let message = get_system_message_for_mode(false, &tools);
        assert!(message.content.contains("read_file"));
        assert!(message.content.contains("Sandbox Tools"));
    }

    #[test]
    fn test_get_system_message_includes_local_tools() {
        let tools = vec![ToolDefinition {
            name: "__local__task_write".to_string(),
            description: "Write task list".to_string(),
            input_schema: serde_json::json!({}),
            title: None,
        }];

        let message = get_system_message_for_mode(true, &tools);
        assert!(message.content.contains("task_write"));
        assert!(message.content.contains("Local Tools"));
    }
}
