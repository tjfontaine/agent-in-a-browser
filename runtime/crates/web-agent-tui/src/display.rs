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
    /// Tool result indicator
    ToolResult {
        /// Tool name
        tool_name: String,
        /// Result preview (truncated)
        result: String,
        /// Whether result was an error
        is_error: bool,
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
                // Using single-width symbols instead of multi-width emojis
                // to avoid column alignment issues in terminal rendering
                let icon = match status {
                    ToolStatus::Calling => "⚙", // U+2699 GEAR (1 cell wide)
                    ToolStatus::Success => "✓", // U+2713 CHECK MARK (1 cell wide)
                    ToolStatus::Error => "✗",   // U+2717 BALLOT X (1 cell wide)
                };
                format!("{} Calling {}...", icon, tool_name)
            }
            DisplayItem::ToolResult {
                tool_name,
                result,
                is_error,
            } => {
                let icon = if *is_error { "✗" } else { "✓" };
                // Truncate result for display
                let preview = if result.len() > 100 {
                    format!("{}...", &result[..100])
                } else {
                    result.clone()
                };
                // Replace newlines with spaces for compact display
                let preview = preview.replace('\n', " ");
                format!("{} {}: {}", icon, tool_name, preview)
            }
            DisplayItem::Notice { text, kind } => {
                let prefix = match kind {
                    NoticeKind::Info => "ℹ",    // U+2139 INFO (1 cell wide)
                    NoticeKind::Warning => "⚠", // U+26A0 WARNING (1 cell wide)
                    NoticeKind::Error => "✗",   // U+2717 BALLOT X (1 cell wide)
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

    /// Create a tool result timeline entry
    pub fn tool_result(
        tool_name: impl Into<String>,
        result: impl Into<String>,
        is_error: bool,
    ) -> Self {
        TimelineEntry::Display(DisplayItem::ToolResult {
            tool_name: tool_name.into(),
            result: result.into(),
            is_error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use insta::assert_snapshot;

    #[test]
    fn display_item_tool_activity_calling() {
        let item = DisplayItem::tool_activity("shell_eval");
        assert_snapshot!(item.display_text());
    }

    #[test]
    fn display_item_tool_result_success() {
        let item = DisplayItem::ToolResult {
            tool_name: "shell_eval".to_string(),
            result: "Hello, World!".to_string(),
            is_error: false,
        };
        assert_snapshot!(item.display_text());
    }

    #[test]
    fn display_item_tool_result_error() {
        let item = DisplayItem::ToolResult {
            tool_name: "shell_eval".to_string(),
            result: "Command not found".to_string(),
            is_error: true,
        };
        assert_snapshot!(item.display_text());
    }

    #[test]
    fn display_item_notice_info() {
        let item = DisplayItem::info("Welcome to Web Agent");
        assert_snapshot!(item.display_text());
    }

    #[test]
    fn display_item_notice_warning() {
        let item = DisplayItem::warning("API key not set");
        assert_snapshot!(item.display_text());
    }

    #[test]
    fn display_item_notice_error() {
        let item = DisplayItem::error("Connection failed");
        assert_snapshot!(item.display_text());
    }

    #[test]
    fn display_item_long_result_truncates() {
        let long_result = "x".repeat(200);
        let item = DisplayItem::ToolResult {
            tool_name: "read_file".to_string(),
            result: long_result,
            is_error: false,
        };
        let text = item.display_text();
        // Should truncate at 100 chars + "..."
        assert!(text.contains("..."));
        assert!(text.len() < 200);
    }
}
