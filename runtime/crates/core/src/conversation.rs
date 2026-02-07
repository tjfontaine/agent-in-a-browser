//! Conversation Model - Unified conversation contract for TUI and headless agents
//!
//! This module defines the internal conversation representation that supports:
//! - Multi-role messages (user, assistant, system, tool)
//! - Tool call/result tracking with metadata
//! - Future compaction via summary and pinned facts
//! - Provider-agnostic message assembly
//!
//! ## Design Goals
//!
//! 1. **Tool Trace Retention**: Tool calls and results are preserved in history
//! 2. **Compaction Ready**: Summary and pinned facts slots for future optimization
//! 3. **Provider Agnostic**: ConversationView builder handles provider formatting
//! 4. **Testable**: Clear invariants for validation
//!
//! ## Usage
//!
//! ```rust,ignore
//! use agent_bridge::conversation::*;
//!
//! // Create a conversation history
//! let mut history = ConversationHistory::new();
//!
//! // Add user message
//! history.append_turn(ConversationTurn::user("Hello"));
//!
//! // Start assistant response
//! history.append_turn(ConversationTurn::assistant(""));
//!
//! // Update as streaming comes in
//! history.update_last_assistant("Hi there!");
//!
//! // Record tool call
//! history.record_tool_call("search", "tool-123", r#"{"query": "rust"}"#);
//!
//! // Record tool result
//! history.record_tool_result("tool-123", "Found 10 results", false);
//!
//! // Get snapshot for provider
//! let messages = history.snapshot_for_provider();
//! ```

use serde::{Deserialize, Serialize};

/// Role of a message in the conversation
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ConversationRole {
    /// User message
    User,
    /// Assistant message
    Assistant,
    /// System message
    System,
    /// Tool call
    ToolCall,
    /// Tool result
    ToolResult,
}

/// Metadata for conversation turns
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TurnMetadata {
    /// Timestamp (seconds since epoch)
    pub timestamp: Option<u64>,
    /// Tool name (for tool calls/results)
    pub tool_name: Option<String>,
    /// Tool call ID (for matching calls to results)
    pub tool_call_id: Option<String>,
    /// Tool arguments (JSON string)
    pub tool_arguments: Option<String>,
    /// Is this an error result?
    pub is_error: bool,
    /// Custom tags for filtering/querying
    pub tags: Vec<String>,
}

/// A single turn in the conversation
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConversationTurn {
    /// Message role
    pub role: ConversationRole,
    /// Message content
    pub content: String,
    /// Turn metadata
    pub metadata: TurnMetadata,
}

impl ConversationTurn {
    /// Create a user message
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ConversationRole::User,
            content: content.into(),
            metadata: TurnMetadata::default(),
        }
    }

    /// Create an assistant message
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ConversationRole::Assistant,
            content: content.into(),
            metadata: TurnMetadata::default(),
        }
    }

    /// Create a system message
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: ConversationRole::System,
            content: content.into(),
            metadata: TurnMetadata::default(),
        }
    }

    /// Create a tool call turn
    pub fn tool_call(tool_name: String, tool_call_id: String, arguments: String) -> Self {
        Self {
            role: ConversationRole::ToolCall,
            content: format!("Calling {} with args: {}", tool_name, arguments),
            metadata: TurnMetadata {
                timestamp: None,
                tool_name: Some(tool_name),
                tool_call_id: Some(tool_call_id),
                tool_arguments: Some(arguments),
                is_error: false,
                tags: vec![],
            },
        }
    }

    /// Create a tool result turn
    pub fn tool_result(tool_call_id: String, result: String, is_error: bool) -> Self {
        Self {
            role: ConversationRole::ToolResult,
            content: result,
            metadata: TurnMetadata {
                timestamp: None,
                tool_name: None,
                tool_call_id: Some(tool_call_id),
                tool_arguments: None,
                is_error,
                tags: vec![],
            },
        }
    }

    /// Add a timestamp to this turn
    pub fn with_timestamp(mut self, timestamp: u64) -> Self {
        self.metadata.timestamp = Some(timestamp);
        self
    }

    /// Add tags to this turn
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.metadata.tags = tags;
        self
    }
}

/// State for conversation compaction (future use)
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ConversationState {
    /// Summary of compacted conversation (future use)
    pub summary: Option<String>,
    /// Facts that must be preserved (user preferences, constraints)
    pub pinned_facts: Vec<String>,
    /// Last compaction timestamp (seconds since epoch)
    pub last_compacted_at: Option<u64>,
}

impl ConversationState {
    /// Create a new empty state
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a pinned fact
    pub fn add_pinned_fact(&mut self, fact: impl Into<String>) {
        self.pinned_facts.push(fact.into());
    }

    /// Set summary
    pub fn set_summary(&mut self, summary: impl Into<String>) {
        self.summary = Some(summary.into());
    }
}

/// Complete conversation history with compaction support
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConversationHistory {
    /// All conversation turns
    turns: Vec<ConversationTurn>,
    /// Conversation state (summary, pinned facts)
    state: ConversationState,
}

impl ConversationHistory {
    /// Create a new empty conversation
    pub fn new() -> Self {
        Self {
            turns: Vec::new(),
            state: ConversationState::new(),
        }
    }

    /// Append a turn to the conversation
    pub fn append_turn(&mut self, turn: ConversationTurn) {
        self.turns.push(turn);
    }

    /// Update the content of the last assistant message
    /// Used during streaming to update partial responses
    pub fn update_last_assistant(&mut self, content: impl Into<String>) {
        if let Some(last) = self.turns.last_mut() {
            if last.role == ConversationRole::Assistant {
                last.content = content.into();
            }
        } else {
            // No assistant message yet - create one
            self.append_turn(ConversationTurn::assistant(content));
        }
    }

    /// Record a tool call
    pub fn record_tool_call(&mut self, tool_name: &str, tool_call_id: &str, arguments: &str) {
        self.append_turn(ConversationTurn::tool_call(
            tool_name.to_string(),
            tool_call_id.to_string(),
            arguments.to_string(),
        ));
    }

    /// Record a tool result
    pub fn record_tool_result(&mut self, tool_call_id: &str, result: &str, is_error: bool) {
        self.append_turn(ConversationTurn::tool_result(
            tool_call_id.to_string(),
            result.to_string(),
            is_error,
        ));
    }

    /// Get all turns
    pub fn turns(&self) -> &[ConversationTurn] {
        &self.turns
    }

    /// Get mutable state
    pub fn state_mut(&mut self) -> &mut ConversationState {
        &mut self.state
    }

    /// Get state
    pub fn state(&self) -> &ConversationState {
        &self.state
    }

    /// Clear all history
    pub fn clear(&mut self) {
        self.turns.clear();
        self.state = ConversationState::new();
    }

    /// Get only user/assistant messages (for simple display)
    pub fn user_assistant_messages(&self) -> Vec<&ConversationTurn> {
        self.turns
            .iter()
            .filter(|t| matches!(t.role, ConversationRole::User | ConversationRole::Assistant))
            .collect()
    }

    /// Snapshot conversation for provider (converts to rig messages)
    ///
    /// This assembles a vector of rig messages suitable for sending to the provider.
    /// Currently returns all user/assistant messages. Future versions will support
    /// compaction with summary injection.
    pub fn snapshot_for_provider(&self) -> Vec<rig::completion::Message> {
        self.turns
            .iter()
            .filter_map(|turn| match turn.role {
                ConversationRole::User => Some(rig::completion::Message::user(&turn.content)),
                ConversationRole::Assistant => {
                    Some(rig::completion::Message::assistant(&turn.content))
                }
                // Tool calls/results are handled by rig internally during multi_turn
                // System messages could be injected as user messages if needed
                _ => None,
            })
            .collect()
    }
}

impl Default for ConversationHistory {
    fn default() -> Self {
        Self::new()
    }
}

/// Builder for constructing conversation views
///
/// This assembles provider-ready messages with proper ordering and constraints.
/// Future versions will support compaction, budget management, and provider-specific formatting.
pub struct ConversationView {
    history: ConversationHistory,
}

impl ConversationView {
    /// Create a view from history
    pub fn from_history(history: ConversationHistory) -> Self {
        Self { history }
    }

    /// Build messages for provider with optional active prompt
    ///
    /// Invariant: If active_prompt is provided, it's always included as the last user message.
    pub fn build_messages(&self, active_prompt: Option<&str>) -> Vec<rig::completion::Message> {
        let mut messages = self.history.snapshot_for_provider();

        // Invariant: latest user prompt always included
        if let Some(prompt) = active_prompt {
            messages.push(rig::completion::Message::user(prompt));
        }

        messages
    }

    /// Build messages with summary injection (future compaction support)
    ///
    /// This would inject the summary before recent turns to reduce context size.
    /// Not yet implemented - reserved for Phase 6 compaction work.
    #[allow(dead_code)]
    pub fn build_with_summary(
        &self,
        _summary: &str,
        _recent_turns: usize,
        _active_prompt: Option<&str>,
    ) -> Vec<rig::completion::Message> {
        todo!("Compaction support to be implemented in Phase 6")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conversation_turn_creation() {
        let user_turn = ConversationTurn::user("Hello");
        assert_eq!(user_turn.role, ConversationRole::User);
        assert_eq!(user_turn.content, "Hello");

        let assistant_turn = ConversationTurn::assistant("Hi");
        assert_eq!(assistant_turn.role, ConversationRole::Assistant);
        assert_eq!(assistant_turn.content, "Hi");
    }

    #[test]
    fn test_tool_call_turn() {
        let tool_call = ConversationTurn::tool_call(
            "search".to_string(),
            "call-1".to_string(),
            r#"{"query": "rust"}"#.to_string(),
        );
        assert_eq!(tool_call.role, ConversationRole::ToolCall);
        assert_eq!(tool_call.metadata.tool_name, Some("search".to_string()));
        assert_eq!(tool_call.metadata.tool_call_id, Some("call-1".to_string()));
    }

    #[test]
    fn test_tool_result_turn() {
        let result = ConversationTurn::tool_result(
            "call-1".to_string(),
            "Found 10 results".to_string(),
            false,
        );
        assert_eq!(result.role, ConversationRole::ToolResult);
        assert_eq!(result.content, "Found 10 results");
        assert!(!result.metadata.is_error);
    }

    #[test]
    fn test_conversation_history_append() {
        let mut history = ConversationHistory::new();
        history.append_turn(ConversationTurn::user("Hello"));
        history.append_turn(ConversationTurn::assistant("Hi"));

        assert_eq!(history.turns().len(), 2);
        assert_eq!(history.turns()[0].role, ConversationRole::User);
        assert_eq!(history.turns()[1].role, ConversationRole::Assistant);
    }

    #[test]
    fn test_update_last_assistant() {
        let mut history = ConversationHistory::new();
        history.append_turn(ConversationTurn::assistant("Partial..."));
        history.update_last_assistant("Complete response");

        assert_eq!(history.turns().len(), 1);
        assert_eq!(history.turns()[0].content, "Complete response");
    }

    #[test]
    fn test_update_last_assistant_creates_if_empty() {
        let mut history = ConversationHistory::new();
        history.update_last_assistant("New message");

        assert_eq!(history.turns().len(), 1);
        assert_eq!(history.turns()[0].role, ConversationRole::Assistant);
        assert_eq!(history.turns()[0].content, "New message");
    }

    #[test]
    fn test_record_tool_call_and_result() {
        let mut history = ConversationHistory::new();
        history.record_tool_call("search", "call-1", r#"{"q": "test"}"#);
        history.record_tool_result("call-1", "Results: ...", false);

        assert_eq!(history.turns().len(), 2);
        assert_eq!(history.turns()[0].role, ConversationRole::ToolCall);
        assert_eq!(history.turns()[1].role, ConversationRole::ToolResult);
    }

    #[test]
    fn test_user_assistant_messages_filter() {
        let mut history = ConversationHistory::new();
        history.append_turn(ConversationTurn::user("Hello"));
        history.record_tool_call("search", "call-1", "{}");
        history.record_tool_result("call-1", "Result", false);
        history.append_turn(ConversationTurn::assistant("Done"));

        let messages = history.user_assistant_messages();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, ConversationRole::User);
        assert_eq!(messages[1].role, ConversationRole::Assistant);
    }

    #[test]
    fn test_snapshot_for_provider() {
        let mut history = ConversationHistory::new();
        history.append_turn(ConversationTurn::user("Hello"));
        history.append_turn(ConversationTurn::assistant("Hi"));

        let messages = history.snapshot_for_provider();
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn test_conversation_view_build_messages() {
        let mut history = ConversationHistory::new();
        history.append_turn(ConversationTurn::user("Hello"));
        history.append_turn(ConversationTurn::assistant("Hi"));

        let view = ConversationView::from_history(history);
        let messages = view.build_messages(Some("How are you?"));

        // Should have 2 history + 1 active prompt
        assert_eq!(messages.len(), 3);
    }

    #[test]
    fn test_conversation_view_preserves_active_prompt() {
        let mut history = ConversationHistory::new();
        history.append_turn(ConversationTurn::user("First"));

        let view = ConversationView::from_history(history);
        let messages = view.build_messages(Some("Second"));

        // Invariant: active prompt must be last
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn test_clear_history() {
        let mut history = ConversationHistory::new();
        history.append_turn(ConversationTurn::user("Hello"));
        history
            .state_mut()
            .add_pinned_fact("User prefers concise answers");

        history.clear();

        assert_eq!(history.turns().len(), 0);
        assert_eq!(history.state().pinned_facts.len(), 0);
    }

    #[test]
    fn test_pinned_facts() {
        let mut state = ConversationState::new();
        state.add_pinned_fact("User prefers Python");
        state.add_pinned_fact("User timezone: UTC");

        assert_eq!(state.pinned_facts.len(), 2);
        assert!(state
            .pinned_facts
            .contains(&"User prefers Python".to_string()));
    }

    #[test]
    fn test_summary_slot() {
        let mut state = ConversationState::new();
        assert!(state.summary.is_none());

        state.set_summary("Previously: user asked about Rust");
        assert_eq!(
            state.summary,
            Some("Previously: user asked about Rust".to_string())
        );
    }
}
