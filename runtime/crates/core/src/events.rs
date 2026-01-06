//! Shared event types for agent callbacks

use serde::{Deserialize, Serialize};

/// Events emitted during agent execution
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum AgentEvent {
    /// Stream started
    StreamStart,
    /// Text chunk received
    StreamChunk(String),
    /// Stream completed
    StreamComplete(String),
    /// Error occurred
    StreamError(String),
    /// Tool call starting
    ToolCall(String),
    /// Tool call completed
    ToolResult(ToolResultData),
    /// Task starting (for agentic workflows)
    TaskStart(TaskInfo),
    /// Task completed
    TaskComplete(TaskResult),
    /// File was written
    FileWritten(FileInfo),
    /// Ready for next input
    Ready,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskResult {
    pub id: String,
    pub success: bool,
    pub output: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolResultData {
    pub name: String,
    pub output: String,
    pub is_error: bool,
}
