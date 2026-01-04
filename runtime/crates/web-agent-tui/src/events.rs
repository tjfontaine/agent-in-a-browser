//! Agent events for UI/Agent decoupling
//!
//! These events are emitted by the agent core and consumed by UI handlers.
//! This enables multiple frontends (TUI, exec, web) on the same agent core.

use crate::display::{NoticeKind, ToolStatus};

/// Agent state for state change events
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AgentState {
    Ready,
    Processing,
    Streaming,
    NeedsApiKey,
}

/// Events emitted by the agent core for handlers to process
#[derive(Clone, Debug)]
pub enum AgentEvent {
    /// User message added to history
    UserMessage { content: String },
    /// Assistant streaming started
    StreamStart,
    /// Text chunk received during streaming
    StreamChunk { text: String },
    /// Tool call in progress
    ToolActivity {
        tool_name: String,
        status: ToolStatus,
    },
    /// Tool result received
    ToolResult {
        tool_name: String,
        result: String,
        is_error: bool,
    },
    /// Stream completed successfully
    StreamComplete { final_text: String },
    /// Stream encountered an error
    StreamError { error: String },
    /// Stream was cancelled by user
    StreamCancelled,
    /// Agent is ready for next input
    Ready,
    /// Notice for display (info, warning, error)
    Notice { text: String, kind: NoticeKind },
    /// Agent state changed
    StateChange { state: AgentState },
}

impl AgentEvent {
    /// Check if this is a terminal event (stream ended)
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            AgentEvent::StreamComplete { .. }
                | AgentEvent::StreamError { .. }
                | AgentEvent::StreamCancelled
                | AgentEvent::Ready
        )
    }
}
