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
    /// If true, LLM is requesting to transition from planning to execution
    pub request_execution: bool,
    /// Optional explanation for plan changes
    pub explanation: Option<String>,
}

/// Process a client-local tool call
/// Returns Some(result) if it's a local tool, None if it should be delegated
pub fn try_execute_local_tool(name: &str, args: Value) -> Option<LocalToolResult> {
    match name {
        "task_write" => Some(execute_task_write(args)),
        "request_execution" => Some(execute_request_execution(args)),
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
                    request_execution: false,
                    explanation: None,
                };
            }
        },
        None => {
            return LocalToolResult {
                success: false,
                message: "Missing 'tasks' argument".to_string(),
                tasks: None,
                request_execution: false,
                explanation: None,
            };
        }
    };

    // Enforce single in_progress constraint
    let in_progress_count = tasks
        .iter()
        .filter(|t| t.status == TaskStatus::InProgress)
        .count();
    if in_progress_count > 1 {
        return LocalToolResult {
            success: false,
            message: "Only one step can be in_progress at a time".to_string(),
            tasks: None,
            request_execution: false,
            explanation: None,
        };
    }

    // Parse optional explanation
    let explanation = args
        .get("explanation")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let count = tasks.len();
    LocalToolResult {
        success: true,
        message: format!("Task list updated: {} tasks", count),
        tasks: Some(tasks),
        request_execution: false,
        explanation,
    }
}

/// Execute the request_execution tool
fn execute_request_execution(args: Value) -> LocalToolResult {
    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    match summary {
        Some(s) => LocalToolResult {
            success: true,
            message: format!("Execution requested: {}", s),
            tasks: None,
            request_execution: true,
            explanation: None,
        },
        None => LocalToolResult {
            success: false,
            message: "Missing 'summary' argument".to_string(),
            tasks: None,
            request_execution: false,
            explanation: None,
        },
    }
}

// ============================================================
// Response Envelope Encoder/Decoder
// ============================================================

/// Response envelope for encoding local tool results with metadata.
/// This envelope preserves metadata like `request_execution` when tool
/// results pass through the rig adapter layer which only returns strings.
#[derive(Serialize, Deserialize)]
struct LocalToolResponse {
    result: LocalToolResultData,
    request_execution: bool,
}

#[derive(Serialize, Deserialize)]
struct LocalToolResultData {
    success: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tasks: Option<Vec<Task>>,
}

/// Encode a LocalToolResult into a JSON envelope string.
/// The envelope preserves metadata like `request_execution` which would
/// otherwise be lost when passing through layers that only handle strings.
pub fn encode_local_tool_response(result: &LocalToolResult) -> String {
    let envelope = LocalToolResponse {
        result: LocalToolResultData {
            success: result.success,
            message: result.message.clone(),
            tasks: result.tasks.clone(),
        },
        request_execution: result.request_execution,
    };
    serde_json::to_string(&envelope).unwrap_or_else(|_| result.message.clone())
}

/// Decode request_execution flag from a JSON response string.
/// Returns false if the JSON is invalid or doesn't contain the field.
/// This is safe to call on any tool result - non-envelope responses return false.
pub fn decode_request_execution(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("request_execution")?.as_bool())
        .unwrap_or(false)
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
    vec![
        LocalToolDefinition {
            name: "task_write".to_string(),
            description: "Manage task list for tracking multi-step work. Updates the task display shown to the user. Only one step can be in_progress at a time.".to_string(),
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
                                "content": { "type": "string", "description": "Task description (5-7 words recommended)" },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed"],
                                    "description": "Task status"
                                }
                            },
                            "required": ["content", "status"]
                        }
                    },
                    "explanation": {
                        "type": "string",
                        "description": "Optional explanation for why the plan changed"
                    }
                },
                "required": ["tasks"]
            }),
        },
        LocalToolDefinition {
            name: "request_execution".to_string(),
            description: "Request to transition from planning to execution mode. Call when plan is complete and ready to execute. User will be prompted to approve.".to_string(),
            title: Some("Request Execution".to_string()),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Brief summary of the plan to execute"
                    }
                },
                "required": ["summary"]
            }),
        },
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
        assert!(!result.request_execution);
    }

    #[test]
    fn test_task_write_missing_tasks() {
        let args = serde_json::json!({});
        let result = try_execute_local_tool("task_write", args).unwrap();
        assert!(!result.success);
    }

    #[test]
    fn test_task_write_single_in_progress() {
        let args = serde_json::json!({
            "tasks": [
                { "id": "1", "content": "First", "status": "in_progress" },
                { "id": "2", "content": "Second", "status": "in_progress" }
            ]
        });
        let result = try_execute_local_tool("task_write", args).unwrap();
        assert!(!result.success);
        assert!(result.message.contains("Only one step"));
    }

    #[test]
    fn test_task_write_with_explanation() {
        let args = serde_json::json!({
            "tasks": [
                { "id": "1", "content": "Test task", "status": "pending" }
            ],
            "explanation": "Added a new step"
        });
        let result = try_execute_local_tool("task_write", args).unwrap();
        assert!(result.success);
        assert_eq!(result.explanation, Some("Added a new step".to_string()));
    }

    #[test]
    fn test_request_execution_success() {
        let args = serde_json::json!({
            "summary": "Implement new feature"
        });
        let result = try_execute_local_tool("request_execution", args).unwrap();
        assert!(result.success);
        assert!(result.request_execution);
        assert!(result.message.contains("Implement new feature"));
    }

    #[test]
    fn test_request_execution_missing_summary() {
        let args = serde_json::json!({});
        let result = try_execute_local_tool("request_execution", args).unwrap();
        assert!(!result.success);
        assert!(!result.request_execution);
        assert!(result.message.contains("Missing 'summary'"));
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

    // ============================================================
    // Response Envelope Encoder/Decoder Tests (TDD)
    // ============================================================

    #[test]
    fn test_encode_local_tool_response_basic() {
        let result = LocalToolResult {
            success: true,
            message: "Task list updated".to_string(),
            tasks: None,
            request_execution: false,
            explanation: None,
        };
        let encoded = encode_local_tool_response(&result);
        let parsed: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(parsed["result"]["success"], true);
        assert_eq!(parsed["result"]["message"], "Task list updated");
        assert_eq!(parsed["request_execution"], false);
    }

    #[test]
    fn test_encode_local_tool_response_with_execution() {
        let result = LocalToolResult {
            success: true,
            message: "Ready to execute".to_string(),
            tasks: None,
            request_execution: true,
            explanation: None,
        };
        let encoded = encode_local_tool_response(&result);
        let parsed: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(parsed["request_execution"], true);
    }

    #[test]
    fn test_encode_local_tool_response_with_tasks() {
        let result = LocalToolResult {
            success: true,
            message: "Tasks updated".to_string(),
            tasks: Some(vec![Task {
                id: "1".to_string(),
                content: "Test".to_string(),
                status: TaskStatus::Pending,
            }]),
            request_execution: false,
            explanation: None,
        };
        let encoded = encode_local_tool_response(&result);
        let parsed: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert!(parsed["result"]["tasks"].is_array());
    }

    #[test]
    fn test_decode_request_execution_true() {
        let json = r#"{"result":{"success":true,"message":"ok"},"request_execution":true}"#;
        assert!(decode_request_execution(json));
    }

    #[test]
    fn test_decode_request_execution_false() {
        let json = r#"{"result":{"success":true,"message":"ok"},"request_execution":false}"#;
        assert!(!decode_request_execution(json));
    }

    #[test]
    fn test_decode_request_execution_missing() {
        // Regular JSON without envelope - should return false
        let json = r#"{"success":true,"message":"ok"}"#;
        assert!(!decode_request_execution(json));
    }

    #[test]
    fn test_decode_request_execution_invalid() {
        // Invalid JSON - should return false
        let json = "not json";
        assert!(!decode_request_execution(json));
    }
}
