//! Configuration management
//!
//! Reads/writes config from OPFS at .config/web-agent/

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;

/// Config file paths (relative to OPFS root)
const CONFIG_DIR: &str = ".config/web-agent";
const CONFIG_FILE: &str = ".config/web-agent/config.toml";
const SERVERS_FILE: &str = ".config/web-agent/servers.toml";
const AGENT_HISTORY_FILE: &str = ".config/web-agent/agent_history";
const SHELL_HISTORY_FILE: &str = ".config/web-agent/shell_history";
const MAX_HISTORY_ENTRIES: usize = 1000;

/// Application configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    /// Provider configurations - each provider has its own stanza
    #[serde(default)]
    pub providers: ProvidersConfig,

    #[serde(default)]
    pub ui: UiConfig,

    // Legacy fields for backwards compatibility - will be migrated
    #[serde(default, skip_serializing)]
    pub provider: Option<LegacyProviderConfig>,

    #[serde(default, skip_serializing)]
    pub models: Option<LegacyModelsConfig>,
}

/// Provider configurations with default selection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvidersConfig {
    /// Which provider to use by default
    #[serde(default = "default_provider")]
    pub default: String,

    /// Dynamic provider settings, keyed by provider ID
    #[serde(flatten)]
    pub providers: HashMap<String, ProviderSettings>,
}

impl Default for ProvidersConfig {
    fn default() -> Self {
        let mut providers = HashMap::new();
        providers.insert(
            "anthropic".to_string(),
            ProviderSettings::default_anthropic(),
        );
        providers.insert("openai".to_string(), ProviderSettings::default_openai());

        Self {
            default: default_provider(),
            providers,
        }
    }
}

/// Settings for a single provider
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderSettings {
    /// Model to use for this provider
    #[serde(default)]
    pub model: String,

    /// API key for this provider
    #[serde(default)]
    pub api_key: Option<String>,

    /// Custom base URL (optional, uses default if not set)
    #[serde(default)]
    pub base_url: Option<String>,

    /// API format - "anthropic" or "openai" (for custom providers)
    #[serde(default)]
    pub api_format: Option<String>,
}

impl ProviderSettings {
    pub fn default_anthropic() -> Self {
        Self {
            model: "claude-sonnet-4-20250514".to_string(),
            api_key: None,
            base_url: None,
            api_format: Some("anthropic".to_string()),
        }
    }

    pub fn default_openai() -> Self {
        Self {
            model: "gpt-4o".to_string(),
            api_key: None,
            base_url: None,
            api_format: Some("openai".to_string()),
        }
    }

    /// Get the API format, defaulting based on provider name
    pub fn get_api_format(&self, provider_id: &str) -> &str {
        self.api_format.as_deref().unwrap_or(match provider_id {
            "anthropic" => "anthropic",
            "gemini" | "google" => "gemini",
            _ => "openai", // Default to OpenAI format for unknown providers
        })
    }
}

fn default_provider() -> String {
    "anthropic".to_string()
}

// Legacy config structs for migration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LegacyProviderConfig {
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LegacyModelsConfig {
    #[serde(default)]
    pub anthropic: String,
    #[serde(default)]
    pub openai: String,
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
    /// Load config from OPFS, returns default if file doesn't exist
    pub fn load() -> Self {
        // Try new path first
        if let Ok(contents) = fs::read_to_string(CONFIG_FILE) {
            let mut config = Self::from_toml(&contents);
            // Migrate legacy config if present
            config.migrate_legacy();
            return config;
        }
        // Migrate from old path if it exists
        if let Ok(contents) = fs::read_to_string(".config/agent-in-a-browser/config.toml") {
            let mut config = Self::from_toml(&contents);
            config.migrate_legacy();
            // Save to new location
            let _ = config.save();
            return config;
        }
        Self::default()
    }

    /// Migrate legacy config format to new per-provider format
    fn migrate_legacy(&mut self) {
        let mut migrated = false;

        // Migrate legacy provider config
        if let Some(legacy) = self.provider.take() {
            if !legacy.default.is_empty() {
                self.providers.default = legacy.default.clone();
            }
            // Put API key on the default provider
            if let Some(api_key) = legacy.api_key {
                self.providers.get_or_create(&legacy.default).api_key = Some(api_key);
            }
            // Put base URL on the default provider
            if let Some(base_url) = legacy.base_url {
                self.providers.get_or_create(&legacy.default).base_url = Some(base_url);
            }
            migrated = true;
        }

        // Migrate legacy models config
        if let Some(legacy) = self.models.take() {
            if !legacy.anthropic.is_empty() {
                self.providers.get_or_create("anthropic").model = legacy.anthropic;
            }
            if !legacy.openai.is_empty() {
                self.providers.get_or_create("openai").model = legacy.openai;
            }
            migrated = true;
        }

        // Save migrated config
        if migrated {
            let _ = self.save();
        }
    }

    /// Save config to OPFS
    pub fn save(&self) -> Result<(), std::io::Error> {
        ensure_config_dir()?;
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

    // === Convenience accessors ===

    /// Get the current provider name
    pub fn current_provider(&self) -> &str {
        &self.providers.default
    }

    /// Get settings for the current provider
    pub fn current_provider_settings(&self) -> &ProviderSettings {
        self.providers.get(&self.providers.default)
    }

    /// Get mutable settings for the current provider
    pub fn current_provider_settings_mut(&mut self) -> &mut ProviderSettings {
        let provider = self.providers.default.clone();
        self.providers.get_or_create(&provider)
    }

    /// Get settings for a specific provider
    pub fn provider_settings(&self, provider: &str) -> &ProviderSettings {
        self.providers.get(provider)
    }

    /// Get mutable settings for a specific provider
    pub fn provider_settings_mut(&mut self, provider: &str) -> &mut ProviderSettings {
        self.providers.get_or_create(provider)
    }

    /// Get the API format for the current provider
    pub fn current_api_format(&self) -> &str {
        let provider = &self.providers.default;
        self.providers.get(provider).get_api_format(provider)
    }
}

impl ProvidersConfig {
    /// Get provider settings, returning a default if not found
    pub fn get(&self, provider: &str) -> &ProviderSettings {
        static DEFAULT_ANTHROPIC: std::sync::LazyLock<ProviderSettings> =
            std::sync::LazyLock::new(ProviderSettings::default_anthropic);
        static DEFAULT_OPENAI: std::sync::LazyLock<ProviderSettings> =
            std::sync::LazyLock::new(ProviderSettings::default_openai);
        static DEFAULT_EMPTY: std::sync::LazyLock<ProviderSettings> =
            std::sync::LazyLock::new(ProviderSettings::default);

        self.providers
            .get(provider)
            .unwrap_or_else(|| match provider {
                "anthropic" => &DEFAULT_ANTHROPIC,
                "openai" => &DEFAULT_OPENAI,
                _ => &DEFAULT_EMPTY,
            })
    }

    /// Get or create provider settings
    pub fn get_or_create(&mut self, provider: &str) -> &mut ProviderSettings {
        if !self.providers.contains_key(provider) {
            let default = match provider {
                "anthropic" => ProviderSettings::default_anthropic(),
                "openai" => ProviderSettings::default_openai(),
                _ => ProviderSettings::default(),
            };
            self.providers.insert(provider.to_string(), default);
        }
        self.providers.get_mut(provider).unwrap()
    }

    /// List all configured provider IDs
    pub fn list_providers(&self) -> Vec<&str> {
        self.providers.keys().map(|s| s.as_str()).collect()
    }
}

// ============================================================================
// MCP Server Configuration
// ============================================================================

/// MCP servers configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ServersConfig {
    #[serde(default)]
    pub servers: Vec<ServerEntry>,
}

/// A single MCP server entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

impl ServersConfig {
    /// Load servers from OPFS
    pub fn load() -> Self {
        match fs::read_to_string(SERVERS_FILE) {
            Ok(contents) => toml::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// Save servers to OPFS
    pub fn save(&self) -> Result<(), std::io::Error> {
        ensure_config_dir()?;
        if let Ok(toml) = toml::to_string_pretty(self) {
            fs::write(SERVERS_FILE, toml)?;
        }
        Ok(())
    }
}

// ============================================================================
// Command History
// ============================================================================

/// Load agent mode history
pub fn load_agent_history() -> Vec<String> {
    load_history_file(AGENT_HISTORY_FILE)
}

/// Save agent mode history
pub fn save_agent_history(history: &[String]) {
    save_history_file(AGENT_HISTORY_FILE, history);
}

/// Load shell mode history
pub fn load_shell_history() -> Vec<String> {
    load_history_file(SHELL_HISTORY_FILE)
}

/// Save shell mode history
pub fn save_shell_history(history: &[String]) {
    save_history_file(SHELL_HISTORY_FILE, history);
}

fn load_history_file(path: &str) -> Vec<String> {
    match fs::read_to_string(path) {
        Ok(contents) => contents.lines().map(|s| s.to_string()).collect(),
        Err(_) => Vec::new(),
    }
}

fn save_history_file(path: &str, history: &[String]) {
    if ensure_config_dir().is_err() {
        return;
    }
    // Take last MAX_HISTORY_ENTRIES
    let start = history.len().saturating_sub(MAX_HISTORY_ENTRIES);
    let trimmed = &history[start..];
    let contents = trimmed.join("\n");
    let _ = fs::write(path, contents);
}

/// Add a command to history (handles deduplication)
pub fn add_to_history(history: &mut Vec<String>, command: String) {
    // Skip empty commands
    if command.trim().is_empty() {
        return;
    }
    // Skip consecutive duplicates
    if history.last().map(|s| s.as_str()) == Some(command.trim()) {
        return;
    }
    history.push(command.trim().to_string());
    // Trim if over limit
    if history.len() > MAX_HISTORY_ENTRIES {
        let excess = history.len() - MAX_HISTORY_ENTRIES;
        history.drain(0..excess);
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn ensure_config_dir() -> Result<(), std::io::Error> {
    if let Err(e) = fs::create_dir_all(CONFIG_DIR) {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(e);
        }
    }
    Ok(())
}
