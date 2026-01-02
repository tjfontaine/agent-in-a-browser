//! WASI Completion Model Type Aliases
//!
//! Type aliases for rig-core models using our WASI HTTP transport.
//! No custom wrappers needed - rig-core handles all provider-specific logic.

use super::wasi_http_adapter::WasiHttpClient;

// ============================================================================
// Anthropic
// ============================================================================

/// Anthropic client using WASI HTTP transport
pub type AnthropicClient = rig::providers::anthropic::Client<WasiHttpClient>;

/// Anthropic completion model using WASI HTTP transport
pub type AnthropicModel = rig::providers::anthropic::completion::CompletionModel<WasiHttpClient>;

/// Re-export response types for convenience
pub use rig::providers::anthropic::completion::CompletionResponse as AnthropicResponse;
pub use rig::providers::anthropic::streaming::StreamingCompletionResponse as AnthropicStreamingResponse;

// ============================================================================
// OpenAI
// ============================================================================

/// OpenAI client (Chat Completions API) using WASI HTTP transport
pub type OpenAIClient = rig::providers::openai::CompletionsClient<WasiHttpClient>;

/// OpenAI completion model using WASI HTTP transport
pub type OpenAIModel = rig::providers::openai::completion::CompletionModel<WasiHttpClient>;

/// Re-export response types for convenience
pub use rig::providers::openai::streaming::StreamingCompletionResponse as OpenAIStreamingResponse;
pub use rig::providers::openai::CompletionResponse as OpenAIResponse;

// ============================================================================
// Gemini (Google)
// ============================================================================

/// Gemini client using WASI HTTP transport
pub type GeminiClient = rig::providers::gemini::Client<WasiHttpClient>;

/// Gemini completion model using WASI HTTP transport
pub type GeminiModel = rig::providers::gemini::completion::CompletionModel<WasiHttpClient>;

/// Re-export response types for convenience
pub use rig::providers::gemini::completion::gemini_api_types::GenerateContentResponse as GeminiResponse;
pub use rig::providers::gemini::streaming::StreamingCompletionResponse as GeminiStreamingResponse;

// ============================================================================
// Client Creation Helpers
// ============================================================================

use rig::client::{ClientBuilder, NeedsApiKey};
use rig::providers::anthropic::client::AnthropicBuilder;
use rig::providers::gemini::client::GeminiBuilder;
use rig::providers::openai::client::OpenAICompletionsExtBuilder;

/// Create an Anthropic client with optional base URL
pub fn create_anthropic_client(
    api_key: &str,
    base_url: Option<&str>,
) -> Result<AnthropicClient, rig::http_client::Error> {
    let mut builder = ClientBuilder::<AnthropicBuilder, NeedsApiKey, WasiHttpClient>::default()
        .http_client(WasiHttpClient::new());

    if let Some(url) = base_url {
        builder = builder.base_url(url);
    }

    builder.api_key(api_key).build()
}

/// Create an OpenAI client with optional base URL
pub fn create_openai_client(
    api_key: &str,
    base_url: Option<&str>,
) -> Result<OpenAIClient, rig::http_client::Error> {
    let mut builder =
        ClientBuilder::<OpenAICompletionsExtBuilder, NeedsApiKey, WasiHttpClient>::default()
            .http_client(WasiHttpClient::new());

    if let Some(url) = base_url {
        builder = builder.base_url(url);
    }

    builder.api_key(api_key).build()
}

/// Create a Gemini client with optional base URL
pub fn create_gemini_client(
    api_key: &str,
    base_url: Option<&str>,
) -> Result<GeminiClient, rig::http_client::Error> {
    let mut builder = ClientBuilder::<GeminiBuilder, NeedsApiKey, WasiHttpClient>::default()
        .http_client(WasiHttpClient::new());

    if let Some(url) = base_url {
        builder = builder.base_url(url);
    }

    builder.api_key(api_key).build()
}
