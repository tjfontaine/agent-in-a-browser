//! Display-only items for TUI rendering
//!
//! These items are transient UI content that should never be sent to the API.
//! Inspired by Codex's `HistoryCell` trait pattern.

use crate::agent_core::{Message, Role};

/// Display-only item (never sent to API)
#[derive(Clone, Debug)]
pub enum DisplayItem {
    /// Tool activity indicator (e.g., "🔧 Calling list...")
    ToolActivity {
        /// Tool name being called
        tool_name: String,
        /// Status of the tool call
        status: ToolStatus,
    },
    /// System notice (warnings, info, errors)
    Notice {
        /// Notice text
        text: String,
        /// Kind of notice
        kind: NoticeKind,
    },
}

/// Status of a tool call
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ToolStatus {
    /// Tool is being called
    Calling,
    /// Tool completed successfully
    Success,
    /// Tool encountered an error
    Error,
}

/// Kind of system notice
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NoticeKind {
    /// Informational notice
    Info,
    /// Warning notice
    Warning,
    /// Error notice
    Error,
}

impl DisplayItem {
    /// Create a new tool activity item
    pub fn tool_activity(tool_name: impl Into<String>) -> Self {
        DisplayItem::ToolActivity {
            tool_name: tool_name.into(),
            status: ToolStatus::Calling,
        }
    }

    /// Create an info notice
    pub fn info(text: impl Into<String>) -> Self {
        DisplayItem::Notice {
            text: text.into(),
            kind: NoticeKind::Info,
        }
    }

    /// Create a warning notice
    pub fn warning(text: impl Into<String>) -> Self {
        DisplayItem::Notice {
            text: text.into(),
            kind: NoticeKind::Warning,
        }
    }

    /// Create an error notice
    pub fn error(text: impl Into<String>) -> Self {
        DisplayItem::Notice {
            text: text.into(),
            kind: NoticeKind::Error,
        }
    }

    /// Get display text for this item
    pub fn display_text(&self) -> String {
        match self {
            DisplayItem::ToolActivity { tool_name, status } => {
                let icon = match status {
                    ToolStatus::Calling => "🔧",
                    ToolStatus::Success => "✅",
                    ToolStatus::Error => "❌",
                };
                format!("{} Calling {}...", icon, tool_name)
            }
            DisplayItem::Notice { text, kind } => {
                let prefix = match kind {
                    NoticeKind::Info => "ℹ️",
                    NoticeKind::Warning => "⚠️",
                    NoticeKind::Error => "❌",
                };
                format!("{} {}", prefix, text)
            }
        }
    }
}

/// Unified timeline entry for chronological display
/// Combines API-bound messages and display-only items in order received
#[derive(Clone, Debug)]
pub enum TimelineEntry {
    /// User or assistant message (also sent to API)
    Message(Message),
    /// Display-only item (UI-only, never sent to API)
    Display(DisplayItem),
}

impl TimelineEntry {
    /// Create a user message timeline entry
    pub fn user_message(content: impl Into<String>) -> Self {
        TimelineEntry::Message(Message {
            role: Role::User,
            content: content.into(),
        })
    }

    /// Create an assistant message timeline entry
    pub fn assistant_message(content: impl Into<String>) -> Self {
        TimelineEntry::Message(Message {
            role: Role::Assistant,
            content: content.into(),
        })
    }

    /// Create an info notice timeline entry
    pub fn info(text: impl Into<String>) -> Self {
        TimelineEntry::Display(DisplayItem::info(text))
    }

    /// Create a warning notice timeline entry
    pub fn warning(text: impl Into<String>) -> Self {
        TimelineEntry::Display(DisplayItem::warning(text))
    }

    /// Create an error notice timeline entry
    pub fn error(text: impl Into<String>) -> Self {
        TimelineEntry::Display(DisplayItem::error(text))
    }

    /// Create a tool activity timeline entry
    pub fn tool_activity(tool_name: impl Into<String>) -> Self {
        TimelineEntry::Display(DisplayItem::tool_activity(tool_name))
    }
}
