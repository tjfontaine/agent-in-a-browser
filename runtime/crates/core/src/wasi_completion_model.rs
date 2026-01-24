//! WASI Completion Model Type Aliases
//!
//! Generic type aliases for rig-core models. The concrete HTTP client
//! type is provided by each component calling these functions.
//!
//! This allows both TUI and headless agent to share the same client
//! creation logic while using their own WIT-generated WasiHttpClient.

use rig::client::{ClientBuilder, NeedsApiKey};
use rig::http_client::HttpClientExt;
use rig::providers::anthropic::client::AnthropicBuilder;
use rig::providers::gemini::client::GeminiBuilder;
use rig::providers::openai::client::OpenAICompletionsExtBuilder;

// ============================================================================
// Anthropic
// ============================================================================

/// Anthropic client using a generic HTTP transport
pub type AnthropicClient<H> = rig::providers::anthropic::Client<H>;

/// Anthropic completion model using a generic HTTP transport
pub type AnthropicModel<H> = rig::providers::anthropic::completion::CompletionModel<H>;

/// Re-export response types for convenience
pub use rig::providers::anthropic::completion::CompletionResponse as AnthropicResponse;
pub use rig::providers::anthropic::streaming::StreamingCompletionResponse as AnthropicStreamingResponse;

// ============================================================================
// OpenAI
// ============================================================================

/// OpenAI client (Chat Completions API) using a generic HTTP transport
pub type OpenAIClient<H> = rig::providers::openai::CompletionsClient<H>;

/// OpenAI completion model using a generic HTTP transport
pub type OpenAIModel<H> = rig::providers::openai::completion::CompletionModel<H>;

/// Re-export response types for convenience
pub use rig::providers::openai::streaming::StreamingCompletionResponse as OpenAIStreamingResponse;
pub use rig::providers::openai::CompletionResponse as OpenAIResponse;

// ============================================================================
// Gemini (Google)
// ============================================================================

/// Gemini client using a generic HTTP transport
pub type GeminiClient<H> = rig::providers::gemini::Client<H>;

/// Gemini completion model using a generic HTTP transport
pub type GeminiModel<H> = rig::providers::gemini::completion::CompletionModel<H>;

/// Re-export response types for convenience
pub use rig::providers::gemini::completion::gemini_api_types::GenerateContentResponse as GeminiResponse;
pub use rig::providers::gemini::streaming::StreamingCompletionResponse as GeminiStreamingResponse;

// ============================================================================
// Client Creation Helpers
// ============================================================================

/// Create an Anthropic client with optional base URL
///
/// # Type Parameters
/// - `H`: HTTP client type implementing `HttpClientExt + Default`
pub fn create_anthropic_client<H>(
    http_client: H,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<AnthropicClient<H>, rig::http_client::Error>
where
    H: HttpClientExt + Default,
{
    let mut builder =
        ClientBuilder::<AnthropicBuilder, NeedsApiKey, H>::default().http_client(http_client);

    if let Some(url) = base_url {
        builder = builder.base_url(url);
    }

    // Enable direct browser access for WASM builds
    // This header is required by Anthropic for API calls from browser contexts
    #[cfg(target_arch = "wasm32")]
    {
        use http::HeaderMap;
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-dangerous-direct-browser-access",
            http::HeaderValue::from_static("true"),
        );
        builder = builder.http_headers(headers);
    }

    builder.api_key(api_key).build()
}

/// Create an OpenAI client with optional base URL
///
/// # Type Parameters
/// - `H`: HTTP client type implementing `HttpClientExt + Default`
pub fn create_openai_client<H>(
    http_client: H,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<OpenAIClient<H>, rig::http_client::Error>
where
    H: HttpClientExt + Default,
{
    let mut builder = ClientBuilder::<OpenAICompletionsExtBuilder, NeedsApiKey, H>::default()
        .http_client(http_client);

    if let Some(url) = base_url {
        builder = builder.base_url(url);
    }

    builder.api_key(api_key).build()
}

/// Create a Gemini client with optional base URL
///
/// # Type Parameters
/// - `H`: HTTP client type implementing `HttpClientExt + Default`
pub fn create_gemini_client<H>(
    http_client: H,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<GeminiClient<H>, rig::http_client::Error>
where
    H: HttpClientExt + Default,
{
    let mut builder =
        ClientBuilder::<GeminiBuilder, NeedsApiKey, H>::default().http_client(http_client);

    if let Some(url) = base_url {
        builder = builder.base_url(url);
    }

    builder.api_key(api_key).build()
}
