//! Configuration management
//! 
//! Reads/writes config from OPFS at .config/agent-in-a-browser/config.toml

use serde::{Deserialize, Serialize};

/// Application configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub provider: ProviderConfig,
    
    #[serde(default)]
    pub ui: UiConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(default = "default_provider")]
    pub default: String,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            default: default_provider(),
        }
    }
}

fn default_provider() -> String {
    "anthropic".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiConfig {
    #[serde(default = "default_theme")]
    pub theme: String,
    
    #[serde(default = "default_aux_panel")]
    pub aux_panel: bool,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            aux_panel: default_aux_panel(),
        }
    }
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_aux_panel() -> bool {
    true
}

impl Config {
    /// Load config from a TOML string
    pub fn from_toml(toml_str: &str) -> Self {
        toml::from_str(toml_str).unwrap_or_default()
    }
    
    /// Serialize to TOML string
    pub fn to_toml(&self) -> Option<String> {
        toml::to_string_pretty(self).ok()
    }
}
