//! AI Client
//!
//! LLM API client using OpenAI-compatible API format.
//! Uses WASI HTTP for making requests.

use super::http_client::{HttpClient, HttpError};
use super::mcp_client::ToolDefinition;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// AI client errors
#[derive(Debug)]
pub enum AiError {
    HttpError(HttpError),
    JsonError(serde_json::Error),
    ApiError(String),
    ParseError(String),
    NoApiKey,
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiError::HttpError(e) => write!(f, "HTTP error: {}", e),
            AiError::JsonError(e) => write!(f, "JSON error: {}", e),
            AiError::ApiError(msg) => write!(f, "API error: {}", msg),
            AiError::ParseError(msg) => write!(f, "Parse error: {}", msg),
            AiError::NoApiKey => write!(f, "No API key configured"),
        }
    }
}

impl std::error::Error for AiError {}

impl From<HttpError> for AiError {
    fn from(e: HttpError) -> Self {
        AiError::HttpError(e)
    }
}

impl From<serde_json::Error> for AiError {
    fn from(e: serde_json::Error) -> Self {
        AiError::JsonError(e)
    }
}

/// Chat message role
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// Chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn system(content: &str) -> Self {
        Self {
            role: Role::System,
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn user(content: &str) -> Self {
        Self {
            role: Role::User,
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn assistant(content: &str) -> Self {
        Self {
            role: Role::Assistant,
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn tool_result(tool_call_id: &str, content: &str) -> Self {
        Self {
            role: Role::Tool,
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.to_string()),
        }
    }
}

/// Tool call from the model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

/// Function call details
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

/// Chat completion response
#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    #[allow(dead_code)]
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ResponseMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    #[allow(dead_code)]
    role: String,
    content: Option<String>,
    tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Deserialize)]
struct Usage {
    #[allow(dead_code)]
    prompt_tokens: u32,
    #[allow(dead_code)]
    completion_tokens: u32,
}

/// Result of a chat completion
#[derive(Debug)]
pub struct ChatResult {
    pub text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
}

/// Streaming event from chat completion
#[derive(Debug)]
pub enum StreamEvent {
    /// Partial text content
    ContentDelta(String),
    /// Tool call started (may have partial arguments)
    ToolCallStart { id: String, name: String },
    /// Tool call argument delta
    ToolCallDelta {
        index: usize,
        arguments_delta: String,
    },
    /// Stream finished with final result
    Done(ChatResult),
}

/// Streaming chat response - iterator over SSE events
pub struct ChatStream {
    body_stream: super::http_client::HttpBodyStream,
    provider_type: ProviderType,
    // Accumulated state for building final result
    accumulated_content: String,
    accumulated_tool_calls: Vec<ToolCall>,
    finish_reason: Option<String>,
}

/// Streaming delta response structures (for parsing OpenAI SSE)
#[derive(Debug, Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    content: Option<String>,
    tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCall {
    index: usize,
    id: Option<String>,
    function: Option<StreamFunction>,
}

#[derive(Debug, Deserialize)]
struct StreamFunction {
    name: Option<String>,
    arguments: Option<String>,
}

/// Anthropic SSE event structures
#[derive(Debug, Deserialize)]
struct AnthropicEvent {
    #[serde(rename = "type")]
    event_type: String,
    delta: Option<AnthropicDelta>,
    content_block: Option<AnthropicContentBlock>,
    index: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct AnthropicDelta {
    #[serde(rename = "type")]
    delta_type: Option<String>,
    text: Option<String>,
    stop_reason: Option<String>,
    partial_json: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    id: Option<String>,
    name: Option<String>,
}

impl ChatStream {
    /// Create a new chat stream from an HTTP body stream
    fn new(body_stream: super::http_client::HttpBodyStream, provider_type: ProviderType) -> Self {
        Self {
            body_stream,
            provider_type,
            accumulated_content: String::new(),
            accumulated_tool_calls: Vec::new(),
            finish_reason: None,
        }
    }

    /// Get next event from the stream
    /// Returns None when stream is exhausted
    pub fn next_event(&mut self) -> Result<Option<StreamEvent>, AiError> {
        match self.provider_type {
            ProviderType::OpenAI | ProviderType::Google => self.next_event_openai(),
            ProviderType::Anthropic => self.next_event_anthropic(),
        }
    }

    /// Parse OpenAI SSE format
    fn next_event_openai(&mut self) -> Result<Option<StreamEvent>, AiError> {
        loop {
            let line = match self.body_stream.read_line() {
                Ok(Some(line)) => line,
                Ok(None) => {
                    return Ok(Some(StreamEvent::Done(ChatResult {
                        text: if self.accumulated_content.is_empty() {
                            None
                        } else {
                            Some(std::mem::take(&mut self.accumulated_content))
                        },
                        tool_calls: std::mem::take(&mut self.accumulated_tool_calls),
                        finish_reason: self.finish_reason.take(),
                    })));
                }
                Err(e) => return Err(AiError::HttpError(e)),
            };

            let line = line.trim();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    return Ok(Some(StreamEvent::Done(ChatResult {
                        text: if self.accumulated_content.is_empty() {
                            None
                        } else {
                            Some(std::mem::take(&mut self.accumulated_content))
                        },
                        tool_calls: std::mem::take(&mut self.accumulated_tool_calls),
                        finish_reason: self.finish_reason.take(),
                    })));
                }

                let chunk: StreamChunk = match serde_json::from_str(data) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                if let Some(choice) = chunk.choices.into_iter().next() {
                    if let Some(reason) = choice.finish_reason {
                        self.finish_reason = Some(reason);
                    }

                    if let Some(content) = choice.delta.content {
                        if !content.is_empty() {
                            self.accumulated_content.push_str(&content);
                            return Ok(Some(StreamEvent::ContentDelta(content)));
                        }
                    }

                    if let Some(tool_calls) = choice.delta.tool_calls {
                        for tc in tool_calls {
                            while self.accumulated_tool_calls.len() <= tc.index {
                                self.accumulated_tool_calls.push(ToolCall {
                                    id: String::new(),
                                    call_type: "function".to_string(),
                                    function: FunctionCall {
                                        name: String::new(),
                                        arguments: String::new(),
                                    },
                                });
                            }

                            let tool_call = &mut self.accumulated_tool_calls[tc.index];

                            if let Some(id) = tc.id {
                                tool_call.id = id;
                            }

                            if let Some(func) = tc.function {
                                if let Some(name) = func.name {
                                    tool_call.function.name = name.clone();
                                    return Ok(Some(StreamEvent::ToolCallStart {
                                        id: tool_call.id.clone(),
                                        name,
                                    }));
                                }
                                if let Some(args) = func.arguments {
                                    tool_call.function.arguments.push_str(&args);
                                    return Ok(Some(StreamEvent::ToolCallDelta {
                                        index: tc.index,
                                        arguments_delta: args,
                                    }));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// Parse Anthropic SSE format
    fn next_event_anthropic(&mut self) -> Result<Option<StreamEvent>, AiError> {
        loop {
            let line = match self.body_stream.read_line() {
                Ok(Some(line)) => line,
                Ok(None) => {
                    return Ok(Some(StreamEvent::Done(ChatResult {
                        text: if self.accumulated_content.is_empty() {
                            None
                        } else {
                            Some(std::mem::take(&mut self.accumulated_content))
                        },
                        tool_calls: std::mem::take(&mut self.accumulated_tool_calls),
                        finish_reason: self.finish_reason.take(),
                    })));
                }
                Err(e) => return Err(AiError::HttpError(e)),
            };

            let line = line.trim();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            // Anthropic format: "event: <type>\ndata: <json>"
            // We handle the data line
            if let Some(data) = line.strip_prefix("data: ") {
                let event: AnthropicEvent = match serde_json::from_str(data) {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                match event.event_type.as_str() {
                    "content_block_delta" => {
                        if let Some(delta) = event.delta {
                            if let Some(text) = delta.text {
                                if !text.is_empty() {
                                    self.accumulated_content.push_str(&text);
                                    return Ok(Some(StreamEvent::ContentDelta(text)));
                                }
                            }
                            // Handle tool input JSON delta
                            if let Some(partial_json) = delta.partial_json {
                                if let Some(index) = event.index {
                                    if index < self.accumulated_tool_calls.len() {
                                        self.accumulated_tool_calls[index]
                                            .function
                                            .arguments
                                            .push_str(&partial_json);
                                        return Ok(Some(StreamEvent::ToolCallDelta {
                                            index,
                                            arguments_delta: partial_json,
                                        }));
                                    }
                                }
                            }
                        }
                    }
                    "content_block_start" => {
                        if let Some(content_block) = event.content_block {
                            if content_block.block_type == "tool_use" {
                                let id = content_block.id.unwrap_or_default();
                                let name = content_block.name.unwrap_or_default();
                                self.accumulated_tool_calls.push(ToolCall {
                                    id: id.clone(),
                                    call_type: "function".to_string(),
                                    function: FunctionCall {
                                        name: name.clone(),
                                        arguments: String::new(),
                                    },
                                });
                                return Ok(Some(StreamEvent::ToolCallStart { id, name }));
                            }
                        }
                    }
                    "message_delta" => {
                        if let Some(delta) = event.delta {
                            if let Some(stop_reason) = delta.stop_reason {
                                self.finish_reason = Some(stop_reason);
                            }
                        }
                    }
                    "message_stop" => {
                        return Ok(Some(StreamEvent::Done(ChatResult {
                            text: if self.accumulated_content.is_empty() {
                                None
                            } else {
                                Some(std::mem::take(&mut self.accumulated_content))
                            },
                            tool_calls: std::mem::take(&mut self.accumulated_tool_calls),
                            finish_reason: self.finish_reason.take(),
                        })));
                    }
                    _ => {} // Ignore other event types
                }
            }
        }
    }
}

/// Model information from provider API
#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

/// Provider type for API format differences
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProviderType {
    Anthropic,
    OpenAI,
    Google,
}

/// AI Client for LLM API calls
pub struct AiClient {
    base_url: String,
    api_key: Option<String>,
    model: String,
    provider_type: ProviderType,
}

impl AiClient {
    /// Create a new AI client
    pub fn new(base_url: &str, model: &str, provider_type: ProviderType) -> Self {
        Self {
            base_url: base_url.to_string(),
            api_key: None,
            model: model.to_string(),
            provider_type,
        }
    }

    /// Create client for Anthropic (default provider)
    pub fn anthropic(model: &str) -> Self {
        Self::new(
            "https://api.anthropic.com/v1",
            model,
            ProviderType::Anthropic,
        )
    }

    /// Create client for OpenAI
    pub fn openai(model: &str) -> Self {
        Self::new("https://api.openai.com/v1", model, ProviderType::OpenAI)
    }

    /// Create default client (Anthropic Claude 3.5 Haiku)
    pub fn default_claude() -> Self {
        Self::anthropic("claude-haiku-4-5-20251001")
    }

    /// Set API key (ephemeral, per-session)
    pub fn set_api_key(&mut self, api_key: &str) {
        self.api_key = Some(api_key.to_string());
    }

    /// Check if API key is configured
    pub fn has_api_key(&self) -> bool {
        self.api_key.is_some()
    }

    /// Get the model name
    pub fn model_name(&self) -> &str {
        &self.model
    }

    /// Set the model (for runtime switching)
    pub fn set_model(&mut self, model: &str) {
        self.model = model.to_string();
    }

    /// Set the base URL (for custom OpenAI-compatible endpoints)
    pub fn set_base_url(&mut self, base_url: &str) {
        self.base_url = base_url.to_string();
    }

    /// Get the current base URL
    pub fn get_base_url(&self) -> &str {
        &self.base_url
    }

    /// Get the provider type
    pub fn provider_type(&self) -> ProviderType {
        self.provider_type
    }

    /// Fetch available models from the provider API
    pub fn list_models(&self) -> Result<Vec<ModelInfo>, AiError> {
        let api_key = self.api_key.as_ref().ok_or(AiError::NoApiKey)?;

        let (url, headers) = match self.provider_type {
            ProviderType::OpenAI => {
                // OpenAI: GET /v1/models with Bearer token
                let url = format!("{}/models", self.base_url);
                let headers = vec![
                    ("Authorization", format!("Bearer {}", api_key)),
                    ("Content-Type", "application/json".to_string()),
                ];
                (url, headers)
            }
            ProviderType::Anthropic => {
                // Anthropic: GET /v1/models with x-api-key header
                let url = format!("{}/models", self.base_url);
                let headers = vec![
                    ("x-api-key", api_key.clone()),
                    ("anthropic-version", "2023-06-01".to_string()),
                    (
                        "anthropic-dangerous-direct-browser-access",
                        "true".to_string(),
                    ),
                    ("Content-Type", "application/json".to_string()),
                ];
                (url, headers)
            }
            ProviderType::Google => {
                // Google: GET /v1beta/models with API key in query param
                let url = format!(
                    "{}?key={}",
                    self.base_url.replace("/v1beta", "/v1beta/models"),
                    api_key
                );
                let headers = vec![("Content-Type", "application/json".to_string())];
                (url, headers)
            }
        };

        // Convert headers for request
        let header_refs: Vec<(&str, &str)> =
            headers.iter().map(|(k, v)| (*k, v.as_str())).collect();

        // Make GET request using HttpClient
        let response = HttpClient::request("GET", &url, &header_refs, None)?;

        // Convert body to string
        let body_str = String::from_utf8_lossy(&response.body).to_string();

        // Parse response based on provider
        self.parse_models_response(&body_str)
    }

    /// Parse models response based on provider type
    fn parse_models_response(&self, response: &str) -> Result<Vec<ModelInfo>, AiError> {
        let json: Value = serde_json::from_str(response)
            .map_err(|e| AiError::ParseError(format!("JSON parse error: {}", e)))?;

        let mut models = Vec::new();

        match self.provider_type {
            ProviderType::OpenAI => {
                // OpenAI format: { "data": [{ "id": "gpt-4", "owned_by": "openai" }, ...] }
                if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
                    for model in data {
                        if let Some(id) = model.get("id").and_then(|v| v.as_str()) {
                            let name = model
                                .get("owned_by")
                                .and_then(|v| v.as_str())
                                .map(|owner| format!("{} ({})", id, owner))
                                .unwrap_or_else(|| id.to_string());
                            models.push(ModelInfo {
                                id: id.to_string(),
                                name,
                            });
                        }
                    }
                }
            }
            ProviderType::Anthropic => {
                // Anthropic format: { "data": [{ "id": "...", "display_name": "..." }, ...] }
                if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
                    for model in data {
                        if let Some(id) = model.get("id").and_then(|v| v.as_str()) {
                            let name = model
                                .get("display_name")
                                .and_then(|v| v.as_str())
                                .unwrap_or(id)
                                .to_string();
                            models.push(ModelInfo {
                                id: id.to_string(),
                                name,
                            });
                        }
                    }
                }
            }
            ProviderType::Google => {
                // Google format: { "models": [{ "name": "models/gemini-...", "displayName": "..." }, ...] }
                if let Some(data) = json.get("models").and_then(|d| d.as_array()) {
                    for model in data {
                        if let Some(name_path) = model.get("name").and_then(|v| v.as_str()) {
                            // Strip "models/" prefix from name
                            let id = name_path
                                .strip_prefix("models/")
                                .unwrap_or(name_path)
                                .to_string();
                            let display_name = model
                                .get("displayName")
                                .and_then(|v| v.as_str())
                                .unwrap_or(&id)
                                .to_string();
                            models.push(ModelInfo {
                                id,
                                name: display_name,
                            });
                        }
                    }
                }
            }
        }

        Ok(models)
    }

    /// Send a chat completion request
    pub fn chat(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<ChatResult, AiError> {
        let api_key = self.api_key.as_ref().ok_or(AiError::NoApiKey)?;

        // Build request
        let mut request = json!({
            "model": self.model,
            "messages": messages,
        });

        // Add tools if any
        if !tools.is_empty() {
            let tool_defs: Vec<Value> = tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.input_schema
                        }
                    })
                })
                .collect();
            request["tools"] = json!(tool_defs);
        }

        // Make request
        let url = format!("{}/chat/completions", self.base_url);
        let body = serde_json::to_string(&request)?;

        let response = HttpClient::post_json(&url, Some(api_key), &body)?;

        // Parse response
        if response.status >= 400 {
            let error_text = String::from_utf8_lossy(&response.body);
            return Err(AiError::ApiError(format!(
                "HTTP {}: {}",
                response.status, error_text
            )));
        }

        let parsed: ChatResponse = serde_json::from_slice(&response.body)?;

        // Extract result from first choice
        if let Some(choice) = parsed.choices.into_iter().next() {
            Ok(ChatResult {
                text: choice.message.content,
                tool_calls: choice.message.tool_calls.unwrap_or_default(),
                finish_reason: choice.finish_reason,
            })
        } else {
            Ok(ChatResult {
                text: None,
                tool_calls: vec![],
                finish_reason: None,
            })
        }
    }

    /// Send a streaming chat completion request
    /// Returns a ChatStream that yields events as tokens arrive
    pub fn chat_streaming(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<ChatStream, AiError> {
        let api_key = self.api_key.as_ref().ok_or(AiError::NoApiKey)?;

        let (url, body, owned_headers) = match self.provider_type {
            ProviderType::Anthropic => self.build_anthropic_request(messages, tools, api_key, true),
            ProviderType::OpenAI | ProviderType::Google => {
                self.build_openai_request(messages, tools, api_key, true)
            }
        }?;

        // Convert owned headers to borrowed for request_streaming
        let headers: Vec<(&str, &str)> = owned_headers
            .iter()
            .map(|(k, v)| (*k, v.as_str()))
            .collect();

        // Make streaming request with provider-specific headers
        let response =
            HttpClient::request_streaming("POST", &url, &headers, Some(body.as_bytes()))?;

        // Check for errors (streaming still returns headers first)
        if response.status >= 400 {
            // Try to read error as text
            let mut error_text = String::new();
            while let Ok(Some(chunk)) = response.stream.read_chunk(4096) {
                error_text.push_str(&String::from_utf8_lossy(&chunk));
            }
            return Err(AiError::ApiError(format!(
                "HTTP {}: {}",
                response.status, error_text
            )));
        }

        Ok(ChatStream::new(response.stream, self.provider_type))
    }

    /// Build OpenAI-format request
    fn build_openai_request(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        api_key: &str,
        stream: bool,
    ) -> Result<(String, String, Vec<(&'static str, String)>), AiError> {
        let mut request = json!({
            "model": self.model,
            "messages": messages,
            "stream": stream,
        });

        if !tools.is_empty() {
            let tool_defs: Vec<Value> = tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.input_schema
                        }
                    })
                })
                .collect();
            request["tools"] = json!(tool_defs);
        }

        let url = format!("{}/chat/completions", self.base_url);
        let body = serde_json::to_string(&request)?;

        let headers = vec![
            ("Content-Type", "application/json".to_string()),
            ("Accept", "text/event-stream".to_string()),
            ("Authorization", format!("Bearer {}", api_key)),
        ];

        Ok((url, body, headers))
    }

    /// Build Anthropic-format request
    fn build_anthropic_request(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        api_key: &str,
        stream: bool,
    ) -> Result<(String, String, Vec<(&'static str, String)>), AiError> {
        // Anthropic uses separate system field
        // Extract system message and filter from messages
        let system_text = messages
            .iter()
            .find(|m| m.role == Role::System)
            .map(|m| m.content.clone());

        // Convert messages to Anthropic format (no system messages in array)
        let anthropic_messages: Vec<Value> = messages
            .iter()
            .filter(|m| m.role != Role::System)
            .map(|m| {
                json!({
                    "role": match m.role {
                        Role::User => "user",
                        Role::Assistant => "assistant",
                        Role::Tool => "user", // Anthropic uses "user" with tool_result content
                        Role::System => unreachable!(),
                    },
                    "content": m.content,
                })
            })
            .collect();

        let mut request = json!({
            "model": self.model,
            "messages": anthropic_messages,
            "max_tokens": 4096,
            "stream": stream,
        });

        if let Some(system) = system_text {
            request["system"] = json!(system);
        }

        // Anthropic tools format
        if !tools.is_empty() {
            let tool_defs: Vec<Value> = tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema
                    })
                })
                .collect();
            request["tools"] = json!(tool_defs);
        }

        let url = format!("{}/messages", self.base_url);
        let body = serde_json::to_string(&request)?;

        let headers = vec![
            ("Content-Type", "application/json".to_string()),
            ("Accept", "text/event-stream".to_string()),
            ("x-api-key", api_key.to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
            (
                "anthropic-dangerous-direct-browser-access",
                "true".to_string(),
            ),
        ];

        Ok((url, body, headers))
    }
}
