//! WASI HTTP Client
//!
//! Wraps WASI HTTP outgoing-handler for making HTTP requests.
//! Used for both LLM API calls and MCP communication.

// Generate generic HttpClient using our component's bindings
// We must pass the full path to the http and io modules separately
agent_bridge::define_general_http_client!(crate::bindings::wasi::http, crate::bindings::wasi::io);
