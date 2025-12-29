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
    NoApiKey,
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiError::HttpError(e) => write!(f, "HTTP error: {}", e),
            AiError::JsonError(e) => write!(f, "JSON error: {}", e),
            AiError::ApiError(msg) => write!(f, "API error: {}", msg),
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

/// AI Client for LLM API calls
pub struct AiClient {
    base_url: String,
    api_key: Option<String>,
    model: String,
}

impl AiClient {
    /// Create a new AI client
    pub fn new(base_url: &str, model: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            api_key: None,
            model: model.to_string(),
        }
    }

    /// Create client for OpenAI
    pub fn openai(model: &str) -> Self {
        Self::new("https://api.openai.com/v1", model)
    }

    /// Create client for Anthropic (via OpenAI-compatible endpoint)
    pub fn anthropic(model: &str) -> Self {
        Self::new("https://api.anthropic.com/v1", model)
    }

    /// Set API key (ephemeral, per-session)
    pub fn set_api_key(&mut self, api_key: &str) {
        self.api_key = Some(api_key.to_string());
    }

    /// Check if API key is configured
    pub fn has_api_key(&self) -> bool {
        self.api_key.is_some()
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
            let tool_defs: Vec<Value> = tools.iter().map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema
                    }
                })
            }).collect();
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
}
