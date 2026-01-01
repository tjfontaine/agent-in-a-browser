//! Bridge to AI and MCP services
//!
//! Provides:
//! - `HttpClient` - WASI HTTP wrapper for making API calls
//! - `McpClient` - Client for calling remote MCP tools
//! - `local_tools` - Client-local tools (task_write, etc.)
//! - `system_prompt` - Agent system prompt
//! - `wasi_completion_model` - Custom CompletionModel for rig-core Agent
//! - `rig_tools` - Tool adapters for rig-core Agent integration
//! - `rig_agent` - High-level Agent wrapper for rig-core

pub mod http_client;
pub mod local_tools;
pub mod mcp_client;
pub mod rig_agent;
pub mod rig_client;
pub mod rig_tools;
pub mod system_prompt;
pub mod wasi_completion_model;
pub mod wasi_http_adapter;

pub use http_client::HttpClient;
pub use local_tools::{
    format_tasks_for_display, get_local_tool_definitions, try_execute_local_tool, Task,
};
pub use mcp_client::McpClient;
pub use rig_agent::{ChatMessage, ChatRole, Provider, RigAgent, RigAgentError, StreamingBuffer};

pub use rig_client::{
    create_anthropic_client, create_openai_client, create_openai_compatible_client,
    create_openai_completions_client, AnthropicClient, OpenAIClient, OpenAICompletionsClient,
};
pub use rig_tools::{build_tool_set, LocalToolAdapter, McpToolAdapter};
pub use system_prompt::{get_system_message, SystemMessage};
pub use wasi_completion_model::{WasiAnthropicModel, WasiOpenAIModel};
pub use wasi_http_adapter::WasiHttpClient;
