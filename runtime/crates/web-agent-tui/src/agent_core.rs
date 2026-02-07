//! Agent Core - UI-agnostic agent logic
//!
//! This module contains the core agent functionality that can be used
//! with any frontend (TUI, embedded, headless).

use crate::bridge::mcp_client::McpClient;
use crate::bridge::rig_agent::RigAgent;
use crate::bridge::ActiveStream;
use crate::config::Config;
use crate::display::{NoticeKind, ToolStatus};
use crate::events::AgentEvent;
use crate::servers::{RemoteServerEntry, ServerConnectionStatus, ToolCollector};
use agent_bridge::decode_request_execution;
use agent_bridge::{ConversationHistory, ConversationRole, ConversationTurn};
use std::collections::VecDeque;

// Simple server status for AgentCore
#[derive(Clone, Default, Debug)]
pub struct ServerStatus {
    pub local_connected: bool,
    pub local_tool_count: usize,
}

/// Message role for conversation history
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Role {
    User,
    Assistant,
}

/// A message in the conversation history (API-only)
#[derive(Clone, Debug)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

/// Core agent state - no UI dependencies
pub struct AgentCore {
    /// Conversation history using unified conversation model
    conversation: ConversationHistory,
    /// Rig-core Agent for multi-turn tool calling
    rig_agent: Option<RigAgent>,
    /// MCP client (local sandbox)
    mcp_client: McpClient,
    /// Configuration
    config: Config,
    /// Active streaming session
    active_stream: Option<ActiveStream>,
    /// Server connection status
    server_status: ServerStatus,
    /// Remote MCP server connections
    remote_servers: Vec<RemoteServerEntry>,
    /// Pending events to be polled
    events: VecDeque<AgentEvent>,
    /// Pending tool activity (used to dedup events)
    last_tool_activity: Option<String>,
    /// Counter for invalidate_agent calls (used in tests)
    pub invalidation_count: usize,
}

impl AgentCore {
    /// Create a new AgentCore with the given configuration
    pub fn new(config: Config, mcp_client: McpClient) -> Self {
        Self {
            conversation: ConversationHistory::new(),
            rig_agent: None,
            mcp_client,
            config,
            active_stream: None,
            server_status: ServerStatus::default(),
            remote_servers: Vec::new(),
            events: VecDeque::new(),
            last_tool_activity: None,
            invalidation_count: 0,
        }
    }

    // === Message Access ===

    /// Get the conversation history (backward compatibility)
    /// Returns only user/assistant messages for display
    pub fn messages(&self) -> Vec<Message> {
        self.conversation
            .user_assistant_messages()
            .iter()
            .map(|turn| Message {
                role: match turn.role {
                    ConversationRole::User => Role::User,
                    ConversationRole::Assistant => Role::Assistant,
                    _ => Role::Assistant, // Shouldn't happen given the filter
                },
                content: turn.content.clone(),
            })
            .collect()
    }

    /// Add a user message to history
    pub fn add_user_message(&mut self, content: &str) {
        self.conversation.append_turn(ConversationTurn::user(content));
        self.emit(AgentEvent::UserMessage {
            content: content.to_string(),
        });
    }

    /// Add an assistant message to history
    pub fn add_assistant_message(&mut self, content: &str) {
        self.conversation
            .append_turn(ConversationTurn::assistant(content));
    }

    /// Update the last assistant message (for streaming)
    pub fn update_last_assistant(&mut self, content: &str) {
        self.conversation.update_last_assistant(content);
    }

    /// Clear conversation history
    pub fn clear_messages(&mut self) {
        self.conversation.clear();
    }

    // === Configuration ===

    /// Get the current provider name
    pub fn provider(&self) -> &str {
        self.config.current_provider()
    }

    /// Get the current model name
    pub fn model(&self) -> &str {
        &self.config.current_provider_settings().model
    }

    /// Check if API key is set for current provider
    pub fn has_api_key(&self) -> bool {
        self.config
            .current_provider_settings()
            .api_key
            .as_ref()
            .map(|k| !k.is_empty())
            .unwrap_or(false)
    }

    /// Get the API key for current provider
    pub fn api_key(&self) -> Option<&str> {
        self.config.current_provider_settings().api_key.as_deref()
    }

    /// Set the API key for current provider
    pub fn set_api_key(&mut self, key: &str) {
        let provider_config = self.config.current_provider_settings_mut();
        provider_config.api_key = Some(key.to_string());

        // Save and notify
        let _ = self.config.save();
        self.emit(AgentEvent::Notice {
            text: "API key saved.".to_string(),
            kind: NoticeKind::Info,
        });
    }

    /// Set the provider
    pub fn set_provider(&mut self, provider: &str) {
        self.config.providers.default = provider.to_string();
        self.rig_agent = None; // Force re-init
        let _ = self.config.save();
    }

    /// Set the model for current provider
    pub fn set_model(&mut self, model: &str) {
        let provider_config = self.config.current_provider_settings_mut();
        provider_config.model = model.to_string();

        self.rig_agent = None; // Force re-init
        let _ = self.config.save();
    }

    /// Set the base URL for current provider
    pub fn set_base_url(&mut self, url: &str) {
        let provider_config = self.config.current_provider_settings_mut();
        provider_config.base_url = Some(url.to_string());

        self.rig_agent = None; // Force re-init
        let _ = self.config.save();
    }

    /// Force agent re-initialization on next message
    /// Call this when available tools change (MCP server added/removed/connected)
    pub fn invalidate_agent(&mut self) {
        self.rig_agent = None;
        self.invalidation_count += 1;
    }

    /// Get mutable config
    pub fn config_mut(&mut self) -> &mut Config {
        &mut self.config
    }

    /// Get config
    pub fn config(&self) -> &Config {
        &self.config
    }

    // === Agent State ===

    /// Get the rig agent (initializes if needed)
    pub fn rig_agent(&self) -> Option<&RigAgent> {
        self.rig_agent.as_ref()
    }

    /// Set the rig agent
    pub fn set_rig_agent(&mut self, agent: RigAgent) {
        self.rig_agent = Some(agent);
    }

    /// Check if currently streaming
    pub fn is_streaming(&self) -> bool {
        self.active_stream.is_some()
    }

    /// Poll for the next event
    pub fn pop_event(&mut self) -> Option<AgentEvent> {
        self.events.pop_front()
    }

    // === MCP Client ===

    /// Get MCP client reference
    pub fn mcp_client(&self) -> &McpClient {
        &self.mcp_client
    }

    /// Get mutable MCP client reference
    pub fn mcp_client_mut(&mut self) -> &mut McpClient {
        &mut self.mcp_client
    }

    // === Server Management ===

    /// Get server status
    pub fn server_status(&self) -> &ServerStatus {
        &self.server_status
    }

    /// Get mutable server status
    pub fn server_status_mut(&mut self) -> &mut ServerStatus {
        &mut self.server_status
    }

    /// Get remote servers
    pub fn remote_servers(&self) -> &[RemoteServerEntry] {
        &self.remote_servers
    }

    /// Get mutable remote servers
    pub fn remote_servers_mut(&mut self) -> &mut Vec<RemoteServerEntry> {
        &mut self.remote_servers
    }

    /// Update server connection status manually if needed
    pub fn set_server_connected(&mut self, id: &str, connected: bool) {
        if let Some(server) = self.remote_servers.iter_mut().find(|s| s.id == id) {
            server.status = if connected {
                ServerConnectionStatus::Connected
            } else {
                ServerConnectionStatus::Disconnected
            };
        }
    }

    // === Streaming Logic ===

    /// Start a stream with the given input
    pub fn send(&mut self, input: &str) -> Result<(), String> {
        if self.active_stream.is_some() {
            return Err("Already streaming".to_string());
        }

        // Add user message to history
        self.add_user_message(input);

        self.start_stream(input)
    }

    /// Start streaming with the given input (assumes input already in messages/history logic)
    pub fn start_stream(&mut self, input: &str) -> Result<(), String> {
        if self.active_stream.is_some() {
            return Err("Already streaming".to_string());
        }

        // Ensure agent is initialized
        if self.rig_agent.is_none() {
            return Err("Agent not initialized".to_string());
        }

        let agent = self.rig_agent.as_ref().unwrap();

        // Get history from conversation (excludes current/last message)
        let all_turns = self.conversation.turns();
        let history_turns = if all_turns.len() > 0 {
            &all_turns[..all_turns.len() - 1]
        } else {
            &[]
        };

        // Convert to Rig format (only user/assistant messages)
        let history = history_turns
            .iter()
            .filter_map(|turn| match turn.role {
                ConversationRole::User => Some(rig::completion::Message::user(&turn.content)),
                ConversationRole::Assistant => {
                    Some(rig::completion::Message::assistant(&turn.content))
                }
                // Tool calls/results are handled by rig internally
                _ => None,
            })
            .collect();

        // Start stream
        let max_turns = self.config.ui.max_turns;
        let active_stream = ActiveStream::start(agent, input, history, None, max_turns);

        self.active_stream = Some(active_stream);
        self.emit(AgentEvent::StreamStart);

        // Add empty assistant message to write into
        self.add_assistant_message("");

        Ok(())
    }

    /// Poll the active stream
    pub fn poll_stream(&mut self) {
        if self.active_stream.is_none() {
            return;
        }

        // We can't move out of self.active_stream directly while self is borrowed mutably
        // So we take it out, poll it, and put it back
        let mut stream = self.active_stream.take().unwrap();
        let result = stream.poll_once();

        // Check for tool activity updates
        let activity = stream.buffer().get_tool_activity();
        if activity != self.last_tool_activity {
            if let Some(act) = &activity {
                self.emit(AgentEvent::ToolActivity {
                    tool_name: act.clone(),
                    status: ToolStatus::Calling,
                });
            } else {
                // Activity cleared - check if we have a tool result
                if let Some((tool_name, result, is_error)) = stream.buffer().take_tool_result() {
                    // Decode request_execution from JSON envelope (returns false if not present)
                    let request_execution = decode_request_execution(&result);
                    self.emit(AgentEvent::ToolResult {
                        tool_name,
                        result,
                        is_error,
                        request_execution,
                    });
                } else if let Some(last) = &self.last_tool_activity {
                    // Fallback if no result stored (shouldn't happen)
                    self.emit(AgentEvent::ToolResult {
                        tool_name: last.clone(),
                        result: "Done".to_string(),
                        is_error: false,
                        request_execution: false,
                    });
                }
            }
            self.last_tool_activity = activity;
        }

        match result {
            crate::bridge::PollResult::Chunk => {
                let content = stream.buffer().get_content();
                self.update_last_assistant(&content);
                self.emit(AgentEvent::StreamChunk { text: content });
                self.active_stream = Some(stream); // Put it back
            }
            crate::bridge::PollResult::Pending => {
                self.active_stream = Some(stream); // Put it back
            }
            crate::bridge::PollResult::Complete => {
                let content = stream.buffer().get_content();
                self.update_last_assistant(&content);
                self.emit(AgentEvent::StreamComplete {
                    final_text: content,
                });
                self.active_stream = None;
            }
            crate::bridge::PollResult::Error(e) => {
                self.emit(AgentEvent::StreamError { error: e });
                self.active_stream = None;
            }
        }
    }

    /// Cancel current stream
    pub fn cancel(&mut self) {
        if let Some(stream) = &self.active_stream {
            stream.buffer().cancel();
        }
        self.active_stream = None;
        self.emit(AgentEvent::StreamCancelled);
    }

    // === Events ===

    /// Queue an event to be polled
    pub fn emit(&mut self, event: AgentEvent) {
        self.events.push_back(event);
    }

    // === Helpers ===

    /// Collect all tools from local and remote servers
    pub fn collect_all_tools(&mut self) -> Vec<crate::bridge::mcp_client::ToolDefinition> {
        // Use closure to access mcp_client
        let (tools, local_connected, local_tool_count) =
            ToolCollector::collect_all_tools(&self.remote_servers, || {
                self.mcp_client.list_tools().map_err(|e| e.to_string())
            });

        self.server_status.local_connected = local_connected;
        self.server_status.local_tool_count = local_tool_count;

        tools
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config::default()
    }

    fn test_mcp_client() -> McpClient {
        McpClient::new("")
    }

    // === Message Management Tests ===

    #[test]
    fn test_add_user_message() {
        let mut core = AgentCore::new(test_config(), test_mcp_client());
        core.add_user_message("Hello, world!");

        let messages = core.messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, Role::User);
        assert_eq!(messages[0].content, "Hello, world!");
    }

    #[test]
    fn test_add_assistant_message() {
        let mut core = AgentCore::new(test_config(), test_mcp_client());
        core.add_assistant_message("I'm an assistant.");

        let messages = core.messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, Role::Assistant);
        assert_eq!(messages[0].content, "I'm an assistant.");
    }

    #[test]
    fn test_update_last_assistant() {
        let mut core = AgentCore::new(test_config(), test_mcp_client());
        core.add_assistant_message("Partial...");
        core.update_last_assistant("Full response.");

        let messages = core.messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Full response.");
    }

    #[test]
    fn test_update_last_assistant_on_empty_adds_message() {
        let mut core = AgentCore::new(test_config(), test_mcp_client());
        core.update_last_assistant("New message");

        // Should add a new assistant message
        let messages = core.messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, Role::Assistant);
    }

    #[test]
    fn test_clear_messages() {
        let mut core = AgentCore::new(test_config(), test_mcp_client());
        core.add_user_message("One");
        core.add_assistant_message("Two");
        core.clear_messages();

        assert!(core.messages().is_empty());
    }

    // === Events Queue Tests ===

    #[test]
    fn test_events_queue_fifo() {
        let mut core = AgentCore::new(test_config(), test_mcp_client());

        core.emit(AgentEvent::StreamStart);
        core.emit(AgentEvent::StreamComplete {
            final_text: "done".to_string(),
        });

        // FIFO order - events come out in order they were emitted
        assert!(matches!(core.pop_event(), Some(AgentEvent::StreamStart)));
        assert!(matches!(
            core.pop_event(),
            Some(AgentEvent::StreamComplete { .. })
        ));
        assert!(core.pop_event().is_none());
    }

    #[test]
    fn test_pop_event_empty() {
        let mut core = AgentCore::new(test_config(), test_mcp_client());
        assert!(core.pop_event().is_none());
    }

    // === Config Access Tests ===

    #[test]
    fn test_provider_default() {
        let core = AgentCore::new(test_config(), test_mcp_client());
        assert_eq!(core.provider(), "anthropic");
    }

    #[test]
    fn test_has_api_key_false_by_default() {
        let core = AgentCore::new(test_config(), test_mcp_client());
        assert!(!core.has_api_key());
    }

    #[test]
    fn test_invalidate_agent_increments_counter() {
        let mut core = AgentCore::new(test_config(), test_mcp_client());
        assert_eq!(core.invalidation_count, 0);

        core.invalidate_agent();
        assert_eq!(core.invalidation_count, 1);

        core.invalidate_agent();
        assert_eq!(core.invalidation_count, 2);
    }

    // === Server Status Tests ===

    #[test]
    fn test_server_status_default() {
        let core = AgentCore::new(test_config(), test_mcp_client());
        assert!(!core.server_status().local_connected);
        assert_eq!(core.server_status().local_tool_count, 0);
    }

    #[test]
    fn test_remote_servers_empty() {
        let core = AgentCore::new(test_config(), test_mcp_client());
        assert!(core.remote_servers().is_empty());
    }

    // === Streaming State Tests ===

    #[test]
    fn test_is_streaming_default_false() {
        let core = AgentCore::new(test_config(), test_mcp_client());
        assert!(!core.is_streaming());
    }

    // === Role Debug Tests ===

    #[test]
    fn test_role_debug_format() {
        assert_eq!(format!("{:?}", Role::User), "User");
        assert_eq!(format!("{:?}", Role::Assistant), "Assistant");
    }
}
