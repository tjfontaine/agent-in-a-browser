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

/// Typed wrapper around tool call arguments for safer extraction
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Arguments(serde_json::Value);

#[allow(dead_code)]
impl Arguments {
    /// Create Arguments from a JSON value
    pub fn new(value: serde_json::Value) -> Self {
        Self(value)
    }

    /// Get a required string parameter
    pub fn get_string(&self, key: &str) -> Result<String, String> {
        self.0
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("Missing required parameter: {}", key))
    }

    /// Get an optional string parameter
    pub fn get_optional_string(&self, key: &str) -> Option<String> {
        self.0
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    /// Get a required boolean parameter
    pub fn get_bool(&self, key: &str) -> Result<bool, String> {
        self.0
            .get(key)
            .and_then(|v| v.as_bool())
            .ok_or_else(|| format!("Missing required parameter: {}", key))
    }

    /// Get the inner JSON value
    pub fn inner(&self) -> &serde_json::Value {
        &self.0
    }
}

/// Tool content item - text, image, audio, resource, or resource_link
#[derive(Debug, Clone, PartialEq)]
pub enum ToolContent {
    Text {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
    },
    Audio {
        data: String,
        mime_type: String,
    },
    Resource {
        uri: String,
        text: Option<String>,
        mime_type: Option<String>,
    },
    ResourceLink {
        uri: String,
        name: Option<String>,
        title: Option<String>,
    },
}

impl Serialize for ToolContent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;

        match self {
            ToolContent::Text { text } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "text")?;
                map.serialize_entry("text", text)?;
                map.end()
            }
            ToolContent::Image { data, mime_type } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "image")?;
                map.serialize_entry("data", data)?;
                map.serialize_entry("mimeType", mime_type)?;
                map.end()
            }
            ToolContent::Audio { data, mime_type } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "audio")?;
                map.serialize_entry("data", data)?;
                map.serialize_entry("mimeType", mime_type)?;
                map.end()
            }
            ToolContent::Resource {
                uri,
                text,
                mime_type,
            } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "resource")?;
                if let Some(text) = text {
                    map.serialize_entry("text", text)?;
                }
                if let Some(mime_type) = mime_type {
                    map.serialize_entry("mimeType", mime_type)?;
                }
                map.serialize_entry("uri", uri)?;
                map.end()
            }
            ToolContent::ResourceLink { uri, name, title } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "resource_link")?;
                if let Some(name) = name {
                    map.serialize_entry("name", name)?;
                }
                if let Some(title) = title {
                    map.serialize_entry("title", title)?;
                }
                map.serialize_entry("uri", uri)?;
                map.end()
            }
        }
    }
}

impl ToolContent {
    /// Create a text content item
    pub fn text(text: impl Into<String>) -> Self {
        ToolContent::Text { text: text.into() }
    }

    /// Create an image content item (base64 encoded)
    pub fn image(data: impl Into<String>, mime_type: impl Into<String>) -> Self {
        ToolContent::Image {
            data: data.into(),
            mime_type: mime_type.into(),
        }
    }

    /// Create an audio content item (base64 encoded)
    pub fn audio(data: impl Into<String>, mime_type: impl Into<String>) -> Self {
        ToolContent::Audio {
            data: data.into(),
            mime_type: mime_type.into(),
        }
    }

    /// Create an embedded resource content item
    pub fn resource(
        uri: impl Into<String>,
        text: impl Into<String>,
        mime_type: Option<String>,
    ) -> Self {
        ToolContent::Resource {
            uri: uri.into(),
            text: Some(text.into()),
            mime_type,
        }
    }

    /// Create a resource link (reference without content)
    pub fn resource_link(
        uri: impl Into<String>,
        name: Option<String>,
        title: Option<String>,
    ) -> Self {
        ToolContent::ResourceLink {
            uri: uri.into(),
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

    // ---- Arguments tests ----

    #[test]
    fn arguments_get_string_present() {
        let args = Arguments::new(json!({"name": "hello"}));
        assert_eq!(args.get_string("name").unwrap(), "hello");
    }

    #[test]
    fn arguments_get_string_missing() {
        let args = Arguments::new(json!({}));
        assert!(args.get_string("name").is_err());
        assert!(args.get_string("name").unwrap_err().contains("name"));
    }

    #[test]
    fn arguments_get_string_wrong_type() {
        let args = Arguments::new(json!({"count": 42}));
        assert!(args.get_string("count").is_err());
    }

    #[test]
    fn arguments_get_optional_string_present() {
        let args = Arguments::new(json!({"path": "/tmp"}));
        assert_eq!(args.get_optional_string("path"), Some("/tmp".to_string()));
    }

    #[test]
    fn arguments_get_optional_string_missing() {
        let args = Arguments::new(json!({}));
        assert_eq!(args.get_optional_string("path"), None);
    }

    #[test]
    fn arguments_get_bool_present() {
        let args = Arguments::new(json!({"recursive": true}));
        assert!(args.get_bool("recursive").unwrap());
    }

    #[test]
    fn arguments_get_bool_missing() {
        let args = Arguments::new(json!({}));
        assert!(args.get_bool("recursive").is_err());
    }

    #[test]
    fn arguments_get_bool_wrong_type() {
        let args = Arguments::new(json!({"recursive": "yes"}));
        assert!(args.get_bool("recursive").is_err());
    }

    #[test]
    fn arguments_inner_returns_value() {
        let val = json!({"key": "value"});
        let args = Arguments::new(val.clone());
        assert_eq!(args.inner(), &val);
    }

    // ---- ToolContent serialization tests ----

    #[test]
    fn tool_content_text_serializes_correctly() {
        let content = ToolContent::text("hello");
        let serialized = serde_json::to_value(&content).unwrap();
        assert_eq!(serialized, json!({"type": "text", "text": "hello"}));
    }

    #[test]
    fn tool_content_image_serializes_correctly() {
        let content = ToolContent::image("base64data", "image/png");
        let serialized = serde_json::to_value(&content).unwrap();
        assert_eq!(
            serialized,
            json!({"type": "image", "data": "base64data", "mimeType": "image/png"})
        );
    }

    #[test]
    fn tool_content_audio_serializes_correctly() {
        let content = ToolContent::audio("audiodata", "audio/mp3");
        let serialized = serde_json::to_value(&content).unwrap();
        assert_eq!(
            serialized,
            json!({"type": "audio", "data": "audiodata", "mimeType": "audio/mp3"})
        );
    }

    #[test]
    fn tool_content_resource_serializes_correctly() {
        let content = ToolContent::resource(
            "file:///test.txt",
            "file content",
            Some("text/plain".into()),
        );
        let serialized = serde_json::to_value(&content).unwrap();
        assert_eq!(
            serialized,
            json!({"type": "resource", "text": "file content", "mimeType": "text/plain", "uri": "file:///test.txt"})
        );
    }

    #[test]
    fn tool_content_resource_link_serializes_correctly() {
        let content =
            ToolContent::resource_link("file:///test.txt", Some("test".to_string()), None);
        let serialized = serde_json::to_value(&content).unwrap();
        assert_eq!(
            serialized,
            json!({"type": "resource_link", "name": "test", "uri": "file:///test.txt"})
        );
    }

    // ---- ToolResult tests ----

    #[test]
    fn test_tool_result_text() {
        let result = ToolResult::text("hello");
        assert_eq!(result.content.len(), 1);
        assert_eq!(
            result.content[0],
            ToolContent::Text {
                text: "hello".to_string()
            }
        );
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
