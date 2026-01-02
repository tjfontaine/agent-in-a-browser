//! WASI Completion Model
//!
//! Custom CompletionModel implementation that uses our WASI HTTP transport.
//! This enables integration with rig-core's Agent abstraction while working
//! within WASI/JSPI constraints.

use rig::client::{ClientBuilder, NeedsApiKey};
use rig::completion::{CompletionModel, CompletionRequest};
use rig::providers::anthropic::client::AnthropicBuilder;
use rig::providers::openai::client::OpenAICompletionsExtBuilder;
use rig::streaming::StreamingCompletionResponse;

use super::wasi_http_adapter::WasiHttpClient;

/// Custom Anthropic completion model that uses WASI HTTP transport.
///
/// This implements `CompletionModel` allowing it to be used with rig-core's
/// `Agent` abstraction for multi-turn conversations with tool calling.
#[derive(Clone)]
pub struct WasiAnthropicModel {
    /// The underlying rig-core Anthropic client (for type reuse)
    client: rig::providers::anthropic::Client<WasiHttpClient>,
    /// Model identifier
    pub model: String,
    /// Default max tokens (required for Anthropic)
    pub default_max_tokens: u64,
}

impl WasiAnthropicModel {
    /// Create a new WASI Anthropic model
    pub fn new(api_key: &str, model: impl Into<String>) -> Result<Self, rig::http_client::Error> {
        let client = ClientBuilder::<AnthropicBuilder, NeedsApiKey, WasiHttpClient>::default()
            .http_client(WasiHttpClient::new())
            .api_key(api_key)
            .build()?;

        let model_str = model.into();
        let default_max_tokens = Self::calculate_max_tokens(&model_str);

        Ok(Self {
            client,
            model: model_str,
            default_max_tokens,
        })
    }

    /// Create a new WASI Anthropic model with a custom base URL
    pub fn with_base_url(
        api_key: &str,
        model: impl Into<String>,
        base_url: &str,
    ) -> Result<Self, rig::http_client::Error> {
        let client = ClientBuilder::<AnthropicBuilder, NeedsApiKey, WasiHttpClient>::default()
            .http_client(WasiHttpClient::new())
            .base_url(base_url)
            .api_key(api_key)
            .build()?;

        let model_str = model.into();
        let default_max_tokens = Self::calculate_max_tokens(&model_str);

        Ok(Self {
            client,
            model: model_str,
            default_max_tokens,
        })
    }

    /// Create with Claude Haiku (fast, cheap)
    pub fn haiku(api_key: &str) -> Result<Self, rig::http_client::Error> {
        Self::new(api_key, "claude-haiku-4-5-20251015")
    }

    /// Create with Claude Sonnet (balanced)
    pub fn sonnet(api_key: &str) -> Result<Self, rig::http_client::Error> {
        Self::new(api_key, "claude-sonnet-4-20250514")
    }

    /// Calculate default max tokens based on model
    fn calculate_max_tokens(model: &str) -> u64 {
        match model {
            m if m.contains("opus") => 32_000,
            m if m.contains("sonnet") && m.contains("3-7") => 64_000,
            m if m.contains("sonnet-4") => 64_000,
            m if m.contains("haiku") => 8_192,
            _ => 4_096,
        }
    }
}

impl std::fmt::Debug for WasiAnthropicModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasiAnthropicModel")
            .field("model", &self.model)
            .field("default_max_tokens", &self.default_max_tokens)
            .finish()
    }
}

/// Re-export the Anthropic response types for use with this model
pub use rig::providers::anthropic::completion::CompletionResponse as AnthropicResponse;
pub use rig::providers::anthropic::streaming::StreamingCompletionResponse as AnthropicStreamingResponse;

impl CompletionModel for WasiAnthropicModel {
    type Response = AnthropicResponse;
    type StreamingResponse = AnthropicStreamingResponse;
    type Client = rig::providers::anthropic::Client<WasiHttpClient>;

    fn make(client: &Self::Client, model: impl Into<String>) -> Self {
        let model_str = model.into();
        Self {
            client: client.clone(),
            model: model_str.clone(),
            default_max_tokens: Self::calculate_max_tokens(&model_str),
        }
    }

    async fn completion(
        &self,
        mut request: CompletionRequest,
    ) -> Result<rig::completion::CompletionResponse<Self::Response>, rig::completion::CompletionError>
    {
        // Ensure max_tokens is set (required for Anthropic)
        if request.max_tokens.is_none() {
            request.max_tokens = Some(self.default_max_tokens);
        }

        // Use the underlying rig-core Anthropic model
        let anthropic_model = rig::providers::anthropic::completion::CompletionModel::new(
            self.client.clone(),
            &self.model,
        );

        anthropic_model.completion(request).await
    }

    async fn stream(
        &self,
        mut request: CompletionRequest,
    ) -> Result<
        StreamingCompletionResponse<Self::StreamingResponse>,
        rig::completion::CompletionError,
    > {
        // Ensure max_tokens is set (required for Anthropic)
        if request.max_tokens.is_none() {
            request.max_tokens = Some(self.default_max_tokens);
        }

        // Use the underlying rig-core Anthropic model
        let anthropic_model = rig::providers::anthropic::completion::CompletionModel::new(
            self.client.clone(),
            &self.model,
        );

        anthropic_model.stream(request).await
    }
}

/// Custom OpenAI completion model that uses WASI HTTP transport.
#[derive(Clone)]
pub struct WasiOpenAIModel {
    /// The underlying rig-core OpenAI client
    client: rig::providers::openai::CompletionsClient<WasiHttpClient>,
    /// Model identifier
    pub model: String,
}

impl WasiOpenAIModel {
    /// Create a new WASI OpenAI model
    pub fn new(api_key: &str, model: impl Into<String>) -> Result<Self, rig::http_client::Error> {
        let client =
            ClientBuilder::<OpenAICompletionsExtBuilder, NeedsApiKey, WasiHttpClient>::default()
                .http_client(WasiHttpClient::new())
                .api_key(api_key)
                .build()?;

        Ok(Self {
            client,
            model: model.into(),
        })
    }

    /// Create a new WASI OpenAI-compatible model with a custom base URL
    ///
    /// This is useful for OpenAI-compatible APIs like Ollama, Groq, vLLM, etc.
    pub fn with_base_url(
        api_key: &str,
        model: impl Into<String>,
        base_url: &str,
    ) -> Result<Self, rig::http_client::Error> {
        let client =
            ClientBuilder::<OpenAICompletionsExtBuilder, NeedsApiKey, WasiHttpClient>::default()
                .http_client(WasiHttpClient::new())
                .base_url(base_url)
                .api_key(api_key)
                .build()?;

        Ok(Self {
            client,
            model: model.into(),
        })
    }

    /// Create with GPT-4o
    pub fn gpt4o(api_key: &str) -> Result<Self, rig::http_client::Error> {
        Self::new(api_key, "gpt-4o")
    }

    /// Create with GPT-4o-mini (fast, cheap)
    pub fn gpt4o_mini(api_key: &str) -> Result<Self, rig::http_client::Error> {
        Self::new(api_key, "gpt-4o-mini")
    }
}

impl std::fmt::Debug for WasiOpenAIModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasiOpenAIModel")
            .field("model", &self.model)
            .finish()
    }
}

pub use rig::providers::openai::streaming::StreamingCompletionResponse as OpenAIStreamingResponse;
/// Re-export the OpenAI response types for use with this model
pub use rig::providers::openai::CompletionResponse as OpenAIResponse;

impl CompletionModel for WasiOpenAIModel {
    type Response = OpenAIResponse;
    type StreamingResponse = OpenAIStreamingResponse;
    type Client = rig::providers::openai::CompletionsClient<WasiHttpClient>;

    fn make(client: &Self::Client, model: impl Into<String>) -> Self {
        Self {
            client: client.clone(),
            model: model.into(),
        }
    }

    async fn completion(
        &self,
        request: CompletionRequest,
    ) -> Result<rig::completion::CompletionResponse<Self::Response>, rig::completion::CompletionError>
    {
        // Use the underlying rig-core OpenAI model
        let openai_model = rig::providers::openai::completion::CompletionModel::new(
            self.client.clone(),
            &self.model,
        );

        openai_model.completion(request).await
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<
        StreamingCompletionResponse<Self::StreamingResponse>,
        rig::completion::CompletionError,
    > {
        // Use the underlying rig-core OpenAI model
        let openai_model = rig::providers::openai::completion::CompletionModel::new(
            self.client.clone(),
            &self.model,
        );

        openai_model.stream(request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_anthropic_max_tokens() {
        assert_eq!(
            WasiAnthropicModel::calculate_max_tokens("claude-haiku-4-5-20251015"),
            8_192
        );
        assert_eq!(
            WasiAnthropicModel::calculate_max_tokens("claude-sonnet-4-20250514"),
            64_000
        );
        assert_eq!(
            WasiAnthropicModel::calculate_max_tokens("claude-opus-4-20250514"),
            32_000
        );
        assert_eq!(
            WasiAnthropicModel::calculate_max_tokens("unknown-model"),
            4_096
        );
    }
}
