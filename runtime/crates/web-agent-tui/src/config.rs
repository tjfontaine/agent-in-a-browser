//! Configuration management
//!
//! Reads/writes config from OPFS at .config/agent-in-a-browser/config.toml

use serde::{Deserialize, Serialize};
use std::fs;

/// Config file paths (relative to OPFS root)
const CONFIG_DIR: &str = ".config/agent-in-a-browser";
const CONFIG_FILE: &str = ".config/agent-in-a-browser/config.toml";

/// Application configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub provider: ProviderConfig,

    #[serde(default)]
    pub ui: UiConfig,

    #[serde(default)]
    pub models: ModelsConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(default = "default_provider")]
    pub default: String,

    /// API key (stored encrypted in real impl, plaintext for now)
    #[serde(default)]
    pub api_key: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            default: default_provider(),
            api_key: None,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelsConfig {
    #[serde(default = "default_anthropic_model")]
    pub anthropic: String,

    #[serde(default = "default_openai_model")]
    pub openai: String,
}

impl Default for ModelsConfig {
    fn default() -> Self {
        Self {
            anthropic: default_anthropic_model(),
            openai: default_openai_model(),
        }
    }
}

fn default_anthropic_model() -> String {
    "claude-sonnet-4-20250514".to_string()
}

fn default_openai_model() -> String {
    "gpt-4o".to_string()
}

impl Config {
    /// Load config from OPFS, returns default if file doesn't exist
    pub fn load() -> Self {
        match fs::read_to_string(CONFIG_FILE) {
            Ok(contents) => Self::from_toml(&contents),
            Err(_) => {
                // Return default config (don't create file until first save)
                Self::default()
            }
        }
    }

    /// Save config to OPFS
    pub fn save(&self) -> Result<(), std::io::Error> {
        // Ensure config directory exists
        if let Err(e) = fs::create_dir_all(CONFIG_DIR) {
            // Ignore "already exists" errors
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(e);
            }
        }

        // Serialize and write
        if let Some(toml) = self.to_toml() {
            fs::write(CONFIG_FILE, toml)?;
        }
        Ok(())
    }

    /// Load config from a TOML string
    pub fn from_toml(toml_str: &str) -> Self {
        toml::from_str(toml_str).unwrap_or_default()
    }

    /// Serialize to TOML string
    pub fn to_toml(&self) -> Option<String> {
        toml::to_string_pretty(self).ok()
    }
}
