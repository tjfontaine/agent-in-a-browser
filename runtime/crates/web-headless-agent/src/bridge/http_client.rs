//! Simple HTTP Client for MCP calls
//!
//! Uses usage of the shared generic HTTP client macro.
//! This provides full streaming support akin to the TUI agent.

// Generate generic HttpClient using our component's bindings
// We must pass the full path to the http and io modules separately
agent_bridge::define_general_http_client!(crate::bindings::wasi::http, crate::bindings::wasi::io);
