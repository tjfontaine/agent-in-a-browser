//! Client-local tools that run in the TUI
//!
//! These tools don't require network calls - they update UI state directly.

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
        Some(tasks_val) => {
            match serde_json::from_value(tasks_val.clone()) {
                Ok(t) => t,
                Err(e) => {
                    return LocalToolResult {
                        success: false,
                        message: format!("Invalid tasks format: {}", e),
                        tasks: None,
                    };
                }
            }
        }
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

/// Get the tool definition for task_write
pub fn get_local_tool_definitions() -> Vec<crate::bridge::mcp_client::ToolDefinition> {
    vec![
        crate::bridge::mcp_client::ToolDefinition {
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
        }
    ]
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
