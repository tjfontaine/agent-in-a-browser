//! WASI Completion Model Type Aliases for TUI
//!
//! Re-exports from agent_bridge with concrete WasiHttpClient type.

use super::wasi_http_adapter::WasiHttpClient;

// ============================================================================
// Type Aliases with concrete WasiHttpClient
// ============================================================================

/// Anthropic client using WASI HTTP transport
pub type AnthropicClient = agent_bridge::AnthropicClient<WasiHttpClient>;

/// Anthropic completion model using WASI HTTP transport
pub type AnthropicModel = agent_bridge::AnthropicModel<WasiHttpClient>;

/// OpenAI client (Chat Completions API) using WASI HTTP transport
pub type OpenAIClient = agent_bridge::OpenAIClient<WasiHttpClient>;

/// OpenAI completion model using WASI HTTP transport
pub type OpenAIModel = agent_bridge::OpenAIModel<WasiHttpClient>;

/// Gemini client using WASI HTTP transport
pub type GeminiClient = agent_bridge::GeminiClient<WasiHttpClient>;

/// Gemini completion model using WASI HTTP transport
pub type GeminiModel = agent_bridge::GeminiModel<WasiHttpClient>;

// ============================================================================
// Re-export response types for convenience
// ============================================================================

pub use rig::providers::anthropic::completion::CompletionResponse as AnthropicResponse;
pub use rig::providers::anthropic::streaming::StreamingCompletionResponse as AnthropicStreamingResponse;
pub use rig::providers::gemini::completion::gemini_api_types::GenerateContentResponse as GeminiResponse;
pub use rig::providers::gemini::streaming::StreamingCompletionResponse as GeminiStreamingResponse;
pub use rig::providers::openai::streaming::StreamingCompletionResponse as OpenAIStreamingResponse;
pub use rig::providers::openai::CompletionResponse as OpenAIResponse;

// ============================================================================
// Client Creation Helpers - delegates to agent_bridge with WasiHttpClient
// ============================================================================

/// Create an Anthropic client with optional base URL
pub fn create_anthropic_client(
    api_key: &str,
    base_url: Option<&str>,
) -> Result<AnthropicClient, rig::http_client::Error> {
    agent_bridge::create_anthropic_client(WasiHttpClient::new(), api_key, base_url)
}

/// Create an OpenAI client with optional base URL
pub fn create_openai_client(
    api_key: &str,
    base_url: Option<&str>,
) -> Result<OpenAIClient, rig::http_client::Error> {
    agent_bridge::create_openai_client(WasiHttpClient::new(), api_key, base_url)
}

/// Create a Gemini client with optional base URL
pub fn create_gemini_client(
    api_key: &str,
    base_url: Option<&str>,
) -> Result<GeminiClient, rig::http_client::Error> {
    agent_bridge::create_gemini_client(WasiHttpClient::new(), api_key, base_url)
}
