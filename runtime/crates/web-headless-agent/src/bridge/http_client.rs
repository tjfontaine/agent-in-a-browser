//! Simple HTTP Client for MCP calls
//!
//! Uses usage of the shared generic HTTP client macro.
//! This provides full streaming support akin to the TUI agent.

// Generate generic HttpClient using our component's bindings
// We must pass the full path to the http and io modules separately
agent_bridge::define_general_http_client!(crate::bindings::wasi::http, crate::bindings::wasi::io);

/// HTTP client for model fetching
/// Implements the ModelFetchHttp trait from agent_bridge
pub struct HeadlessHttpClient;

impl agent_bridge::ModelFetchHttp for HeadlessHttpClient {
    fn get_json(&self, url: &str, headers: &[(&str, &str)]) -> Result<serde_json::Value, String> {
        HttpClient::get_json_with_headers(url, headers).map_err(|e| e.to_string())
    }
}
