//! WASI Completion Model Type Aliases
//!
//! Type aliases for rig-core models using our WASI HTTP transport.

use super::wasi_http_adapter::WasiHttpClient;

// ============================================================================
// Anthropic
// ============================================================================

pub type AnthropicClient = rig::providers::anthropic::Client<WasiHttpClient>;
pub type AnthropicModel = rig::providers::anthropic::completion::CompletionModel<WasiHttpClient>;

// ============================================================================
// OpenAI
// ============================================================================

pub type OpenAIClient = rig::providers::openai::CompletionsClient<WasiHttpClient>;
pub type OpenAIModel = rig::providers::openai::completion::CompletionModel<WasiHttpClient>;

// ============================================================================
// Gemini
// ============================================================================

pub type GeminiClient = rig::providers::gemini::Client<WasiHttpClient>;
pub type GeminiModel = rig::providers::gemini::completion::CompletionModel<WasiHttpClient>;

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
