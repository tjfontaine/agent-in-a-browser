//! MCP Protocol types

use serde::{Deserialize, Serialize};

/// MCP Server Info
#[derive(Debug, Serialize, Clone)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

/// MCP Log Level for notifications/message
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    #[default]
    Info,
    Notice,
    Warning,
    Error,
    Critical,
    Alert,
    Emergency,
}

/// MCP Log Message for notifications/message notification
#[derive(Debug, Serialize)]
pub struct LogMessage {
    pub level: LogLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logger: Option<String>,
    pub data: serde_json::Value,
}

impl LogMessage {
    /// Create a log message with the given level and data
    pub fn new(level: LogLevel, data: impl Into<serde_json::Value>) -> Self {
        Self {
            level,
            logger: None,
            data: data.into(),
        }
    }

    /// Create an info-level log message
    pub fn info(message: impl Into<String>) -> Self {
        Self::new(
            LogLevel::Info,
            serde_json::json!({ "message": message.into() }),
        )
    }

    /// Create an error-level log message
    pub fn error(message: impl Into<String>) -> Self {
        Self::new(
            LogLevel::Error,
            serde_json::json!({ "message": message.into() }),
        )
    }

    /// Create a debug-level log message
    pub fn debug(message: impl Into<String>) -> Self {
        Self::new(
            LogLevel::Debug,
            serde_json::json!({ "message": message.into() }),
        )
    }
}

/// MCP Tool Annotations - hints about tool behavior per 2025-11-25 spec
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    /// If true, the tool does not modify any state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    /// If true, the tool may perform destructive operations
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    /// If true, calling this tool multiple times with same args has same effect
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
    /// If true, the tool interacts with external systems
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_world_hint: Option<bool>,
}

/// MCP Tool Definition - extended for 2025-11-25 spec
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    /// Human-readable display name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// JSON Schema for expected output structure
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
    /// Hints about tool behavior
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<ToolAnnotations>,
}

/// MCP Tool Result - aligned with rmcp's CallToolResult
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    /// The content returned by the tool (text, images, etc.)
    pub content: Vec<ToolContent>,
    /// Whether this result represents an error condition
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// An optional JSON object that represents the structured result of the tool call
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<serde_json::Value>,
    /// Optional protocol-level metadata for this result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

/// Tool content item - text, image, audio, resource, or resource_link
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    /// Text content (for type: "text")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Base64 encoded data (for type: "image", "audio")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// MIME type (for type: "image", "audio")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Resource URI (for type: "resource", "resource_link")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// Resource name (for type: "resource", "resource_link")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Resource title (for type: "resource", "resource_link")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl ToolContent {
    /// Create a text content item
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content_type: "text".to_string(),
            text: Some(text.into()),
            data: None,
            mime_type: None,
            uri: None,
            name: None,
            title: None,
        }
    }

    /// Create an image content item (base64 encoded)
    pub fn image(data: impl Into<String>, mime_type: impl Into<String>) -> Self {
        Self {
            content_type: "image".to_string(),
            text: None,
            data: Some(data.into()),
            mime_type: Some(mime_type.into()),
            uri: None,
            name: None,
            title: None,
        }
    }

    /// Create an audio content item (base64 encoded)
    pub fn audio(data: impl Into<String>, mime_type: impl Into<String>) -> Self {
        Self {
            content_type: "audio".to_string(),
            text: None,
            data: Some(data.into()),
            mime_type: Some(mime_type.into()),
            uri: None,
            name: None,
            title: None,
        }
    }

    /// Create an embedded resource content item
    pub fn resource(
        uri: impl Into<String>,
        text: impl Into<String>,
        mime_type: Option<String>,
    ) -> Self {
        Self {
            content_type: "resource".to_string(),
            text: Some(text.into()),
            data: None,
            mime_type,
            uri: Some(uri.into()),
            name: None,
            title: None,
        }
    }

    /// Create a resource link (reference without content)
    pub fn resource_link(
        uri: impl Into<String>,
        name: Option<String>,
        title: Option<String>,
    ) -> Self {
        Self {
            content_type: "resource_link".to_string(),
            text: None,
            data: None,
            mime_type: None,
            uri: Some(uri.into()),
            name,
            title,
        }
    }
}

impl ToolResult {
    /// Create a successful tool result with content items
    pub fn success(content: Vec<ToolContent>) -> Self {
        Self {
            content,
            is_error: None,
            structured_content: None,
            meta: None,
        }
    }

    /// Create a successful tool result with a single text content item
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::text(text)],
            is_error: None,
            structured_content: None,
            meta: None,
        }
    }

    /// Create an error tool result with a message
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::text(message)],
            is_error: Some(true),
            structured_content: None,
            meta: None,
        }
    }

    /// Create a successful tool result with structured JSON content
    pub fn structured(value: serde_json::Value) -> Self {
        Self {
            content: vec![],
            is_error: None,
            structured_content: Some(value),
            meta: None,
        }
    }

    /// Create an error tool result with structured JSON content
    pub fn structured_error(value: serde_json::Value) -> Self {
        Self {
            content: vec![],
            is_error: Some(true),
            structured_content: Some(value),
            meta: None,
        }
    }

    /// Add metadata to this result
    pub fn with_meta(mut self, meta: serde_json::Value) -> Self {
        self.meta = Some(meta);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_tool_result_text() {
        let result = ToolResult::text("hello");
        assert_eq!(result.content.len(), 1);
        assert_eq!(result.content[0].text, Some("hello".to_string()));
        assert_eq!(result.content[0].content_type, "text");
        assert!(result.is_error.is_none());
    }

    #[test]
    fn test_tool_result_error() {
        let result = ToolResult::error("something went wrong");
        assert_eq!(result.content.len(), 1);
        assert_eq!(result.is_error, Some(true));
    }

    #[test]
    fn test_tool_definition_extended() {
        let tool = ToolDefinition {
            name: "test_tool".to_string(),
            description: "A test tool".to_string(),
            input_schema: json!({"type": "object"}),
            title: Some("Test Tool".to_string()),
            output_schema: Some(json!({"type": "string"})),
            annotations: Some(ToolAnnotations {
                read_only_hint: Some(true),
                destructive_hint: None,
                idempotent_hint: Some(true),
                open_world_hint: None,
            }),
        };

        let serialized = serde_json::to_string(&tool).unwrap();
        assert!(serialized.contains("\"title\":\"Test Tool\""));
        assert!(serialized.contains("\"readOnlyHint\":true"));
    }

    #[test]
    fn test_tool_annotations_default() {
        let annotations = ToolAnnotations::default();
        assert!(annotations.read_only_hint.is_none());
    }
}
