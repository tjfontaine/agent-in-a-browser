//! Agent Bridge - Shared LLM integration components
//!
//! This crate provides the core components for integrating with LLM providers
//! via rig-core, usable by both TUI and headless agent.
//!
//! ## Architecture
//!
//! The bridge uses **traits** to abstract over WIT bindings:
//!
//! - [`HttpTransport`] - Abstracts HTTP operations (implemented per-component using WIT)
//! - [`McpTransport`] - Abstracts MCP tool calls (local sandbox, remote servers)
//! - [`StreamEventHandler`] - Abstracts event emission during streaming
//!
//! This allows shared agent logic to work across different WASM components,
//! each with their own WIT-generated bindings.

pub mod active_stream;
pub mod events;
pub mod http_transport;
pub mod local_tools;
pub mod mcp_transport;
pub mod remote_mcp_client;
pub mod rig_agent;
pub mod rig_tools;
pub mod wasi_completion_model;
pub mod wasi_http_macro;
pub mod wasm_async;

// Re-export commonly used items
pub use active_stream::StreamItem;
pub use active_stream::{
    erase_stream, ActiveStream, ActiveStreamState, ErasedConnectFuture, ErasedStream,
    ErasedStreamResult, PollResult, StreamingBuffer,
};
pub use events::{AgentEvent, FileInfo, TaskInfo, TaskResult, ToolResultData};
pub use http_transport::{
    HttpBodyStream, HttpError, HttpResponse, HttpStreamingResponse, HttpTransport,
};
pub use local_tools::{
    format_tasks_for_display, get_local_tool_definitions, try_execute_local_tool,
    LocalToolDefinition, LocalToolResult, Task, TaskStatus,
};
pub use mcp_transport::{
    JsonRpcError, JsonRpcResponse, McpError, McpTransport, ToolContent, ToolDefinition, ToolResult,
};
pub use remote_mcp_client::RemoteMcpClient;
pub use rig_agent::{process_stream, EventCollector, StreamEventHandler};
pub use rig_tools::{build_tool_set, McpToolAdapter};
pub use wasi_completion_model::{
    create_anthropic_client, create_gemini_client, create_openai_client, AnthropicClient,
    AnthropicModel, GeminiClient, GeminiModel, OpenAIClient, OpenAIModel,
};
pub use wasm_async::wasm_block_on;
