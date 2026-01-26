//! Static provider and model information
//!
//! Provides static lists of AI providers and their available models.
//! These lists are maintained manually and updated with new model releases.
//! For live model lists, use `models_api` which fetches from provider APIs.

/// Information about an AI provider
#[derive(Debug, Clone)]
pub struct ProviderInfo {
    /// Provider ID (e.g., "anthropic", "openai")
    pub id: &'static str,
    /// Display name (e.g., "Anthropic (Claude)")
    pub name: &'static str,
    /// Default base URL (None = use rig-core defaults)
    pub default_base_url: Option<&'static str>,
    /// API format to use ("anthropic", "openai", or "gemini")
    pub api_format: &'static str,
}

/// Information about a model
#[derive(Debug, Clone)]
pub struct ModelInfo {
    /// Model ID used in API calls
    pub id: &'static str,
    /// Human-readable display name
    pub name: &'static str,
}

/// Available AI providers
pub const PROVIDERS: &[ProviderInfo] = &[
    ProviderInfo {
        id: "anthropic",
        name: "Anthropic (Claude)",
        default_base_url: None,
        api_format: "anthropic",
    },
    ProviderInfo {
        id: "openai",
        name: "OpenAI (GPT)",
        default_base_url: None,
        api_format: "openai",
    },
    ProviderInfo {
        id: "gemini",
        name: "Google (Gemini)",
        default_base_url: None,
        api_format: "gemini",
    },
    ProviderInfo {
        id: "openrouter",
        name: "OpenRouter",
        default_base_url: Some("https://openrouter.ai/api/v1"),
        api_format: "openai",
    },
    ProviderInfo {
        id: "custom",
        name: "Custom (OpenAI-compatible)",
        default_base_url: None,
        api_format: "openai",
    },
];

/// Get provider info by ID
pub fn get_provider(provider_id: &str) -> Option<&'static ProviderInfo> {
    PROVIDERS.iter().find(|p| p.id == provider_id)
}

/// Get default model for a provider (first in the list)
pub fn get_default_model(provider_id: &str) -> Option<ModelInfo> {
    get_models_for_provider(provider_id).into_iter().next()
}

/// Get static model list for a provider
/// Returns tuples of (model_id, display_name)
/// Updated January 2026 with latest available models
pub fn get_models_for_provider(provider: &str) -> Vec<ModelInfo> {
    match provider {
        "anthropic" => vec![
            ModelInfo {
                id: "claude-haiku-4-5-20251015",
                name: "Claude Haiku 4.5 (Fast, Default)",
            },
            ModelInfo {
                id: "claude-sonnet-4-5-20250929",
                name: "Claude Sonnet 4.5",
            },
            ModelInfo {
                id: "claude-opus-4-5-20251124",
                name: "Claude Opus 4.5 (Most Powerful)",
            },
            ModelInfo {
                id: "claude-opus-4-1-20250805",
                name: "Claude Opus 4.1",
            },
            ModelInfo {
                id: "claude-sonnet-4-20250522",
                name: "Claude Sonnet 4",
            },
            ModelInfo {
                id: "claude-3-7-sonnet-20250224",
                name: "Claude 3.7 Sonnet",
            },
        ],
        "openai" => vec![
            ModelInfo {
                id: "gpt-5.2",
                name: "GPT-5.2 (Latest)",
            },
            ModelInfo {
                id: "gpt-5.1",
                name: "GPT-5.1",
            },
            ModelInfo {
                id: "gpt-5",
                name: "GPT-5",
            },
            ModelInfo {
                id: "o4-mini",
                name: "o4-mini (Fast Reasoning)",
            },
            ModelInfo {
                id: "o3-pro",
                name: "o3-pro (Deep Reasoning)",
            },
            ModelInfo {
                id: "o3",
                name: "o3 (Reasoning)",
            },
            ModelInfo {
                id: "gpt-4.1",
                name: "GPT-4.1 (Coding)",
            },
            ModelInfo {
                id: "gpt-4o",
                name: "GPT-4o",
            },
            ModelInfo {
                id: "gpt-4o-mini",
                name: "GPT-4o Mini (Fast)",
            },
            ModelInfo {
                id: "codex-max",
                name: "Codex-Max (Software Dev)",
            },
        ],
        "google" | "gemini" => vec![
            ModelInfo {
                id: "gemini-3-flash",
                name: "Gemini 3 Flash (Fast, Default)",
            },
            ModelInfo {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro (Most Powerful)",
            },
            ModelInfo {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
            },
            ModelInfo {
                id: "gemini-2.5-flash-lite",
                name: "Gemini 2.5 Flash Lite (Fastest)",
            },
            ModelInfo {
                id: "gemini-2.0-flash",
                name: "Gemini 2.0 Flash",
            },
            ModelInfo {
                id: "gemini-2.0-flash-lite",
                name: "Gemini 2.0 Flash Lite",
            },
        ],
        "openrouter" => vec![
            ModelInfo {
                id: "anthropic/claude-haiku-4-5",
                name: "Claude Haiku 4.5",
            },
            ModelInfo {
                id: "anthropic/claude-sonnet-4-5",
                name: "Claude Sonnet 4.5",
            },
            ModelInfo {
                id: "anthropic/claude-opus-4-5",
                name: "Claude Opus 4.5",
            },
            ModelInfo {
                id: "openai/gpt-5.2",
                name: "GPT-5.2",
            },
            ModelInfo {
                id: "openai/o4-mini",
                name: "o4-mini",
            },
            ModelInfo {
                id: "google/gemini-3-flash",
                name: "Gemini 3 Flash",
            },
        ],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_providers_not_empty() {
        assert!(!PROVIDERS.is_empty());
    }

    #[test]
    fn test_anthropic_models() {
        let models = get_models_for_provider("anthropic");
        assert!(!models.is_empty());
        assert!(models.iter().any(|m| m.id.contains("claude")));
    }

    #[test]
    fn test_openai_models() {
        let models = get_models_for_provider("openai");
        assert!(!models.is_empty());
        assert!(models.iter().any(|m| m.id.contains("gpt")));
    }

    #[test]
    fn test_gemini_models() {
        let models = get_models_for_provider("gemini");
        assert!(!models.is_empty());
        // Also test "google" alias
        let google_models = get_models_for_provider("google");
        assert_eq!(models.len(), google_models.len());
    }

    #[test]
    fn test_unknown_provider_returns_empty() {
        let models = get_models_for_provider("unknown_provider");
        assert!(models.is_empty());
    }
}
