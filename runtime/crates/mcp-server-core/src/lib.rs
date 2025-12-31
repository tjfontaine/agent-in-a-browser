//! MCP Server Core - Types and traits for Model Context Protocol servers
//!
//! This crate provides the core types and traits needed to implement MCP servers,
//! including JSON-RPC 2.0 types, MCP protocol types, and the McpServer trait.
//!
//! ## Features
//! - JSON-RPC 2.0 request/response types
//! - MCP protocol types (tools, resources, prompts)
//! - SSE notification helpers
//! - McpServer trait for implementing servers
//!
//! ## Example
//! ```rust,ignore
//! use mcp_server_core::{McpServer, ServerInfo, ToolDefinition, ToolResult};
//!
//! struct MyServer;
//!
//! impl McpServer for MyServer {
//!     fn server_info(&self) -> ServerInfo {
//!         ServerInfo {
//!             name: "my-server".to_string(),
//!             version: "1.0.0".to_string(),
//!         }
//!     }
//!     
//!     fn list_tools(&self) -> Vec<ToolDefinition> {
//!         vec![]
//!     }
//!     
//!     fn call_tool(&mut self, name: &str, arguments: serde_json::Value) -> ToolResult {
//!         ToolResult::text("Hello!")
//!     }
//! }
//! ```

mod handler;
mod jsonrpc;
mod protocol;

pub use handler::{handle_request, McpServer};
pub use jsonrpc::{JsonRpcError, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse};
pub use protocol::{
    LogLevel, LogMessage, ServerInfo, ToolAnnotations, ToolContent, ToolDefinition, ToolResult,
};

#[cfg(feature = "stdio")]
mod stdio;
#[cfg(feature = "stdio")]
pub use stdio::run_stdio_server;
