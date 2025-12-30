//! Configuration management
//!
//! Reads/writes config from OPFS at .config/web-agent/

use serde::{Deserialize, Serialize};
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

    /// Custom base URL for OpenAI-compatible providers (Ollama, Groq, etc.)
    #[serde(default)]
    pub base_url: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            default: default_provider(),
            api_key: None,
            base_url: None,
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
        // Try new path first
        if let Ok(contents) = fs::read_to_string(CONFIG_FILE) {
            return Self::from_toml(&contents);
        }
        // Migrate from old path if it exists
        if let Ok(contents) = fs::read_to_string(".config/agent-in-a-browser/config.toml") {
            let config = Self::from_toml(&contents);
            // Save to new location
            let _ = config.save();
            return config;
        }
        Self::default()
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
