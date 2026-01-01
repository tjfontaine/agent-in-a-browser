//! Rig-Core AI Client using WASI HTTP
//!
//! Provides a rig-core based AI client that uses our WasiHttpClient adapter
//! for making API calls. This leverages rig-core's battle-tested provider
//! abstractions for Anthropic, OpenAI, and other LLM providers.
//!
//! Note: The rig-core ClientBuilder uses a typestate pattern that makes it
//! difficult to create intermediate builder states. These factory functions
//! handle the full construction flow.

// Re-export our HTTP client for convenience
pub use super::wasi_http_adapter::WasiHttpClient;

use rig::client::{Client, ClientBuilder, NeedsApiKey};
use rig::providers::anthropic::client::{AnthropicBuilder, AnthropicExt};
use rig::providers::openai::client::{
    OpenAICompletionsExt, OpenAICompletionsExtBuilder, OpenAIResponsesExt,
    OpenAIResponsesExtBuilder,
};

/// Type aliases for rig-core clients using our WASI HTTP adapter
pub type AnthropicClient = Client<AnthropicExt, WasiHttpClient>;
pub type OpenAIClient = Client<OpenAIResponsesExt, WasiHttpClient>;
pub type OpenAICompletionsClient = Client<OpenAICompletionsExt, WasiHttpClient>;

/// Create an Anthropic client using the WASI HTTP adapter
///
/// # Arguments
/// * `api_key` - Anthropic API key
///
/// # Example
/// ```ignore
/// let client = create_anthropic_client("your-api-key")?;
/// let model = client.completion_model("claude-sonnet-4-20250514");
/// ```
pub fn create_anthropic_client(api_key: &str) -> Result<AnthropicClient, rig::http_client::Error> {
    ClientBuilder::<AnthropicBuilder, NeedsApiKey, WasiHttpClient>::default()
        .http_client(WasiHttpClient::new())
        .api_key(api_key)
        .build()
}

/// Create an OpenAI Responses API client using the WASI HTTP adapter
///
/// This uses OpenAI's newer Responses API which is the default for new integrations.
///
/// # Arguments
/// * `api_key` - OpenAI API key
pub fn create_openai_client(api_key: &str) -> Result<OpenAIClient, rig::http_client::Error> {
    ClientBuilder::<OpenAIResponsesExtBuilder, NeedsApiKey, WasiHttpClient>::default()
        .http_client(WasiHttpClient::new())
        .api_key(api_key)
        .build()
}

/// Create an OpenAI Chat Completions API client using the WASI HTTP adapter
///
/// # Arguments  
/// * `api_key` - OpenAI API key
pub fn create_openai_completions_client(
    api_key: &str,
) -> Result<OpenAICompletionsClient, rig::http_client::Error> {
    ClientBuilder::<OpenAICompletionsExtBuilder, NeedsApiKey, WasiHttpClient>::default()
        .http_client(WasiHttpClient::new())
        .api_key(api_key)
        .build()
}

/// Create an OpenAI-compatible client with a custom base URL
///
/// Useful for services like Ollama, vLLM, or other OpenAI-compatible APIs.
///
/// # Arguments
/// * `api_key` - API key (may be empty for local services)
/// * `base_url` - Custom base URL for the API
pub fn create_openai_compatible_client(
    api_key: &str,
    base_url: &str,
) -> Result<OpenAICompletionsClient, rig::http_client::Error> {
    ClientBuilder::<OpenAICompletionsExtBuilder, NeedsApiKey, WasiHttpClient>::default()
        .http_client(WasiHttpClient::new())
        .base_url(base_url)
        .api_key(api_key)
        .build()
}
