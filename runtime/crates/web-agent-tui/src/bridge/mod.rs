//! Bridge to AI and MCP services
//!
//! Provides:
//! - `HttpClient` - WASI HTTP wrapper for making API calls
//! - `McpClient` - Client for calling remote MCP tools
//! - `AiClient` - LLM API client (OpenAI-compatible)

pub mod http_client;
pub mod mcp_client;
pub mod ai_client;

pub use http_client::HttpClient;
pub use mcp_client::McpClient;
pub use ai_client::AiClient;
