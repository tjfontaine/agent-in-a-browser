//! Models API - Dynamic model fetching from provider APIs
//!
//! Provides functions to fetch available models from provider APIs.
//! Requires an API key for authentication.
//!
//! For static fallback lists, see [`super::models`].

use crate::models::ModelInfo;
use serde::Deserialize;

/// Owned version of ModelInfo for dynamic fetching
#[derive(Debug, Clone)]
pub struct FetchedModel {
    pub id: String,
    pub name: String,
}

impl From<FetchedModel> for ModelInfo {
    fn from(m: FetchedModel) -> Self {
        // This leaks memory, but is only used for dynamic results
        // In practice, these are cached and the leak is minimal
        ModelInfo {
            id: Box::leak(m.id.into_boxed_str()),
            name: Box::leak(m.name.into_boxed_str()),
        }
    }
}

// ============================================================================
// Response types for provider APIs
// ============================================================================

/// OpenAI models list response
#[derive(Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModel>,
}

#[derive(Deserialize)]
struct OpenAIModel {
    id: String,
}

/// Anthropic models list response
#[derive(Deserialize)]
struct AnthropicModelsResponse {
    data: Vec<AnthropicModel>,
}

#[derive(Deserialize)]
struct AnthropicModel {
    id: String,
    display_name: Option<String>,
}

/// Gemini models list response
#[derive(Deserialize)]
struct GeminiModelsResponse {
    models: Vec<GeminiModelInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModelInfo {
    name: String,
    display_name: Option<String>,
}

// ============================================================================
// Generic HTTP trait for model fetching
// ============================================================================

/// Trait for making HTTP requests (allows different implementations for TUI vs headless)
pub trait ModelFetchHttp {
    /// GET JSON from a URL with optional headers
    fn get_json(&self, url: &str, headers: &[(&str, &str)]) -> Result<serde_json::Value, String>;
}

// ============================================================================
// Model fetching functions
// ============================================================================

/// Fetch models from OpenAI API
pub fn fetch_openai_models<H: ModelFetchHttp>(
    http: &H,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<Vec<FetchedModel>, String> {
    let url = format!("{}/models", base_url.unwrap_or("https://api.openai.com/v1"));

    let response = http
        .get_json(&url, &[("Authorization", &format!("Bearer {}", api_key))])
        .map_err(|e| format!("HTTP error: {}", e))?;

    let models_response: OpenAIModelsResponse =
        serde_json::from_value(response).map_err(|e| format!("Failed to parse response: {}", e))?;

    // Filter to only completion/chat models
    let models: Vec<FetchedModel> = models_response
        .data
        .into_iter()
        .filter(|m| {
            let id = m.id.as_str();
            (id.starts_with("gpt-")
                || id.starts_with("o1")
                || id.starts_with("o3")
                || id.starts_with("o4"))
                && !id.contains("realtime")
                && !id.contains("audio")
                && !id.contains("transcribe")
        })
        .map(|m| FetchedModel {
            name: m.id.clone(),
            id: m.id,
        })
        .collect();

    Ok(models)
}

/// Fetch models from Anthropic API
pub fn fetch_anthropic_models<H: ModelFetchHttp>(
    http: &H,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<Vec<FetchedModel>, String> {
    let url = format!(
        "{}/models",
        base_url.unwrap_or("https://api.anthropic.com/v1")
    );

    let response = http
        .get_json(
            &url,
            &[
                ("x-api-key", api_key),
                ("anthropic-version", "2023-06-01"),
                ("anthropic-dangerous-direct-browser-access", "true"),
            ],
        )
        .map_err(|e| format!("HTTP error: {}", e))?;

    let models_response: AnthropicModelsResponse =
        serde_json::from_value(response).map_err(|e| format!("Failed to parse response: {}", e))?;

    let models: Vec<FetchedModel> = models_response
        .data
        .into_iter()
        .map(|m| FetchedModel {
            name: m.display_name.unwrap_or_else(|| m.id.clone()),
            id: m.id,
        })
        .collect();

    Ok(models)
}

/// Fetch models from Gemini API
pub fn fetch_gemini_models<H: ModelFetchHttp>(
    http: &H,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<Vec<FetchedModel>, String> {
    let url = format!(
        "{}/models?key={}",
        base_url.unwrap_or("https://generativelanguage.googleapis.com/v1beta"),
        api_key
    );

    // Gemini uses key in URL, no auth headers needed
    let response = http
        .get_json(&url, &[])
        .map_err(|e| format!("HTTP error: {}", e))?;

    let models_response: GeminiModelsResponse =
        serde_json::from_value(response).map_err(|e| format!("Failed to parse response: {}", e))?;

    let models: Vec<FetchedModel> = models_response
        .models
        .into_iter()
        .filter(|m| m.name.contains("gemini"))
        .map(|m| {
            let id = m
                .name
                .strip_prefix("models/")
                .unwrap_or(&m.name)
                .to_string();
            FetchedModel {
                name: m.display_name.unwrap_or_else(|| id.clone()),
                id,
            }
        })
        .collect();

    Ok(models)
}

/// Fetch models for a provider (dispatches to provider-specific function)
pub fn fetch_models_for_provider<H: ModelFetchHttp>(
    http: &H,
    provider: &str,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<Vec<FetchedModel>, String> {
    match provider {
        "anthropic" => fetch_anthropic_models(http, api_key, base_url),
        "gemini" | "google" => fetch_gemini_models(http, api_key, base_url),
        "openai" | "custom" | "openrouter" => fetch_openai_models(http, api_key, base_url),
        _ => fetch_openai_models(http, api_key, base_url),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockHttp {
        response: serde_json::Value,
    }

    impl ModelFetchHttp for MockHttp {
        fn get_json(
            &self,
            _url: &str,
            _headers: &[(&str, &str)],
        ) -> Result<serde_json::Value, String> {
            Ok(self.response.clone())
        }
    }

    #[test]
    fn test_parse_openai_response() {
        let mock = MockHttp {
            response: serde_json::json!({
                "data": [
                    {"id": "gpt-4o"},
                    {"id": "gpt-4o-mini"},
                    {"id": "text-embedding-ada-002"}, // Should be filtered out
                ]
            }),
        };

        let models = fetch_openai_models(&mock, "test-key", None).unwrap();
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|m| m.id == "gpt-4o"));
    }

    #[test]
    fn test_parse_anthropic_response() {
        let mock = MockHttp {
            response: serde_json::json!({
                "data": [
                    {"id": "claude-3-sonnet", "display_name": "Claude 3 Sonnet"},
                    {"id": "claude-3-haiku", "display_name": null},
                ]
            }),
        };

        let models = fetch_anthropic_models(&mock, "test-key", None).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "Claude 3 Sonnet");
        assert_eq!(models[1].name, "claude-3-haiku"); // Falls back to id
    }
}
