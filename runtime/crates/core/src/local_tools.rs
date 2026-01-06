//! Client-local tools that run in the agent
//!
//! These tools don't require network calls - they update UI state directly.
//! Shared between TUI and headless agent.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A task in the task list
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub content: String,
    pub status: TaskStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

impl Default for TaskStatus {
    fn default() -> Self {
        TaskStatus::Pending
    }
}

/// Result of a local tool execution
pub struct LocalToolResult {
    pub success: bool,
    pub message: String,
    pub tasks: Option<Vec<Task>>,
}

/// Process a client-local tool call
/// Returns Some(result) if it's a local tool, None if it should be delegated
pub fn try_execute_local_tool(name: &str, args: Value) -> Option<LocalToolResult> {
    match name {
        "task_write" => Some(execute_task_write(args)),
        _ => None,
    }
}

/// Execute the task_write tool
fn execute_task_write(args: Value) -> LocalToolResult {
    let tasks: Vec<Task> = match args.get("tasks") {
        Some(tasks_val) => match serde_json::from_value(tasks_val.clone()) {
            Ok(t) => t,
            Err(e) => {
                return LocalToolResult {
                    success: false,
                    message: format!("Invalid tasks format: {}", e),
                    tasks: None,
                };
            }
        },
        None => {
            return LocalToolResult {
                success: false,
                message: "Missing 'tasks' argument".to_string(),
                tasks: None,
            };
        }
    };

    let count = tasks.len();
    LocalToolResult {
        success: true,
        message: format!("Task list updated: {} tasks", count),
        tasks: Some(tasks),
    }
}

/// Tool definition matching MCP format
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolDefinition {
    pub name: String,
    pub description: String,
    pub title: Option<String>,
    pub input_schema: Value,
}

/// Get the tool definitions for all local tools
pub fn get_local_tool_definitions() -> Vec<LocalToolDefinition> {
    vec![LocalToolDefinition {
        name: "task_write".to_string(),
        description: "Manage task list for tracking multi-step work. Updates the task display shown to the user.".to_string(),
        title: Some("Task Writer".to_string()),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "description": "Array of task objects with id, content, and status",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "Unique task identifier" },
                            "content": { "type": "string", "description": "Task description" },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                                "description": "Task status"
                            }
                        },
                        "required": ["content", "status"]
                    }
                }
            },
            "required": ["tasks"]
        }),
    }]
}

/// Format a task list for display in the aux panel
pub fn format_tasks_for_display(tasks: &[Task]) -> String {
    if tasks.is_empty() {
        return "No tasks defined.".to_string();
    }

    let mut output = String::new();
    for task in tasks {
        let status_icon = match task.status {
            TaskStatus::Pending => "○",
            TaskStatus::InProgress => "◐",
            TaskStatus::Completed => "●",
        };
        output.push_str(&format!("{} {}\n", status_icon, task.content));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_write_success() {
        let args = serde_json::json!({
            "tasks": [
                { "id": "1", "content": "Test task", "status": "pending" }
            ]
        });
        let result = try_execute_local_tool("task_write", args).unwrap();
        assert!(result.success);
        assert_eq!(result.tasks.unwrap().len(), 1);
    }

    #[test]
    fn test_task_write_missing_tasks() {
        let args = serde_json::json!({});
        let result = try_execute_local_tool("task_write", args).unwrap();
        assert!(!result.success);
    }

    #[test]
    fn test_unknown_tool() {
        let args = serde_json::json!({});
        assert!(try_execute_local_tool("unknown", args).is_none());
    }

    #[test]
    fn test_format_tasks() {
        let tasks = vec![
            Task {
                id: "1".to_string(),
                content: "First".to_string(),
                status: TaskStatus::Pending,
            },
            Task {
                id: "2".to_string(),
                content: "Second".to_string(),
                status: TaskStatus::Completed,
            },
        ];
        let output = format_tasks_for_display(&tasks);
        assert!(output.contains("○ First"));
        assert!(output.contains("● Second"));
    }
}
