//! Models API for fetching available models from AI providers
//!
//! Provides functions to dynamically fetch model lists from provider APIs.

use super::http_client::HttpClient;
use serde::Deserialize;

/// A model available from the provider
#[derive(Debug, Clone)]
pub struct AvailableModel {
    /// Model ID (used for API calls)
    pub id: String,
    /// Display name (often same as ID)
    pub name: String,
}

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

/// Fetch models from OpenAI API
pub fn fetch_openai_models(
    api_key: &str,
    base_url: Option<&str>,
) -> Result<Vec<AvailableModel>, String> {
    let url = format!("{}/models", base_url.unwrap_or("https://api.openai.com/v1"));

    let response =
        HttpClient::get_json(&url, Some(api_key)).map_err(|e| format!("HTTP error: {}", e))?;

    if response.status != 200 {
        return Err(format!(
            "API returned status {}: {}",
            response.status,
            String::from_utf8_lossy(&response.body)
        ));
    }

    let models_response: OpenAIModelsResponse = serde_json::from_slice(&response.body)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    // Filter to only completion/chat models (exclude embeddings, whisper, dall-e, etc.)
    let models: Vec<AvailableModel> = models_response
        .data
        .into_iter()
        .filter(|m| {
            let id = m.id.as_str();
            // Include GPT models, O1/O3 models, and exclude non-chat models
            (id.starts_with("gpt-") || id.starts_with("o1") || id.starts_with("o3"))
                && !id.contains("realtime")
                && !id.contains("audio")
                && !id.contains("transcribe")
        })
        .map(|m| AvailableModel {
            name: m.id.clone(),
            id: m.id,
        })
        .collect();

    Ok(models)
}

/// Fetch models from Anthropic API
pub fn fetch_anthropic_models(api_key: &str) -> Result<Vec<AvailableModel>, String> {
    let url = "https://api.anthropic.com/v1/models";

    // Anthropic uses x-api-key header instead of Bearer token
    // anthropic-dangerous-direct-browser-access is required for browser CORS
    let response = HttpClient::get_json_with_headers(
        url,
        &[
            ("x-api-key", api_key),
            ("anthropic-version", "2023-06-01"),
            ("anthropic-dangerous-direct-browser-access", "true"),
        ],
    )
    .map_err(|e| format!("HTTP error: {}", e))?;

    if response.status != 200 {
        return Err(format!(
            "API returned status {}: {}",
            response.status,
            String::from_utf8_lossy(&response.body)
        ));
    }

    let models_response: AnthropicModelsResponse = serde_json::from_slice(&response.body)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let models: Vec<AvailableModel> = models_response
        .data
        .into_iter()
        .map(|m| AvailableModel {
            name: m.display_name.unwrap_or_else(|| m.id.clone()),
            id: m.id,
        })
        .collect();

    Ok(models)
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

/// Fetch models from Gemini API
///
/// Gemini uses query parameter auth (?key=API_KEY) instead of headers
pub fn fetch_gemini_models(api_key: &str) -> Result<Vec<AvailableModel>, String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={}",
        api_key
    );

    // Gemini doesn't need auth headers - key is in URL
    let response =
        HttpClient::get_json_with_headers(&url, &[]).map_err(|e| format!("HTTP error: {}", e))?;

    if response.status != 200 {
        return Err(format!(
            "API returned status {}: {}",
            response.status,
            String::from_utf8_lossy(&response.body)
        ));
    }

    let models_response: GeminiModelsResponse = serde_json::from_slice(&response.body)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    // Filter to generative models only
    let models: Vec<AvailableModel> = models_response
        .models
        .into_iter()
        .filter(|m| m.name.contains("gemini"))
        .map(|m| {
            // Model name comes as "models/gemini-1.5-pro" - extract just the model ID
            let id = m
                .name
                .strip_prefix("models/")
                .unwrap_or(&m.name)
                .to_string();
            AvailableModel {
                name: m.display_name.unwrap_or_else(|| id.clone()),
                id,
            }
        })
        .collect();

    Ok(models)
}

/// Fetch models based on provider type
pub fn fetch_models_for_provider(
    provider: &str,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<Vec<AvailableModel>, String> {
    match provider {
        "anthropic" => fetch_anthropic_models(api_key),
        "gemini" | "google" => fetch_gemini_models(api_key),
        "openai" | "custom" | _ => fetch_openai_models(api_key, base_url),
    }
}
