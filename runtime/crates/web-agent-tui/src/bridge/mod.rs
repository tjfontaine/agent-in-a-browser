//! Bridge to AI and MCP services
//!
//! Provides:
//! - `HttpClient` - WASI HTTP wrapper for making API calls
//! - `McpClient` - Client for calling remote MCP tools
//! - `AiClient` - LLM API client (OpenAI-compatible)
//! - `local_tools` - Client-local tools (task_write, etc.)
//! - `system_prompt` - Agent system prompt

pub mod http_client;
pub mod mcp_client;
pub mod ai_client;
pub mod local_tools;
pub mod system_prompt;

pub use http_client::HttpClient;
pub use mcp_client::McpClient;
pub use ai_client::AiClient;
pub use local_tools::{try_execute_local_tool, get_local_tool_definitions, Task, format_tasks_for_display};
pub use system_prompt::get_system_message;
