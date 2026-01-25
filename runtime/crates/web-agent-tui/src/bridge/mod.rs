//! Bridge to AI and MCP services
//!
//! This module contains bridges to external systems like LLM providers,
//! MCP servers, and HTTP clients.

pub mod http_client;
pub mod local_tools;
pub mod mcp_client;
pub mod models_api;
pub mod oauth_client;

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
pub use rig_agent::{
    ActiveStream, ChatMessage, ChatRole, PollResult, Provider, RigAgent, RigAgentError,
    StreamingBuffer,
};

pub use rig_client::{
    create_anthropic_client, create_openai_client, create_openai_compatible_client,
    create_openai_completions_client, AnthropicClient, OpenAIClient, OpenAICompletionsClient,
};
pub use rig_tools::{build_tool_set, LocalToolAdapter, McpToolAdapter};
pub use system_prompt::{get_system_message, get_system_message_for_mode, SystemMessage};
pub use wasi_completion_model::{AnthropicModel, GeminiModel, OpenAIModel};
pub use wasi_http_adapter::WasiHttpClient;
