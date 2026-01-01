//! Rig-Core Agent Wrapper
//!
//! High-level agent abstraction using rig-core's Agent for multi-turn
//! conversations with automatic tool calling.

use futures::executor::block_on;
use futures::StreamExt;
use rig::agent::Agent;
use rig::completion::{Chat, Message as RigMessage, Prompt};
use rig::streaming::StreamingPrompt;
use rig::tool::server::ToolServer;
use rig::tool::ToolSet;
use std::future::IntoFuture;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::mcp_client::McpClient;
use super::rig_tools::{LocalToolAdapter, McpToolAdapter};
use super::wasi_completion_model::{WasiAnthropicModel, WasiOpenAIModel};

/// Shared buffer for streaming content
///
/// This allows async streaming to write chunks while the TUI reads them.
#[derive(Clone)]
pub struct StreamingBuffer {
    /// The accumulated content so far
    content: Arc<Mutex<String>>,
    /// Whether the stream is complete
    complete: Arc<AtomicBool>,
    /// Whether the stream was cancelled
    cancelled: Arc<AtomicBool>,
    /// Any error that occurred
    error: Arc<Mutex<Option<String>>>,
    /// Current tool activity (tool being called)
    tool_activity: Arc<Mutex<Option<String>>>,
}

impl StreamingBuffer {
    /// Create a new empty streaming buffer
    pub fn new() -> Self {
        Self {
            content: Arc::new(Mutex::new(String::new())),
            complete: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(None)),
            tool_activity: Arc::new(Mutex::new(None)),
        }
    }

    /// Append content to the buffer
    pub fn append(&self, text: &str) {
        if let Ok(mut content) = self.content.lock() {
            content.push_str(text);
        }
    }

    /// Get the current accumulated content
    pub fn get_content(&self) -> String {
        self.content.lock().map(|c| c.clone()).unwrap_or_default()
    }

    /// Check if streaming is complete
    pub fn is_complete(&self) -> bool {
        self.complete.load(Ordering::Relaxed)
    }

    /// Mark the stream as complete
    pub fn set_complete(&self) {
        self.complete.store(true, Ordering::Relaxed);
    }

    /// Check if streaming was cancelled
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Cancel the stream
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    /// Set an error
    pub fn set_error(&self, err: String) {
        if let Ok(mut error) = self.error.lock() {
            *error = Some(err);
        }
        self.set_complete();
    }

    /// Get any error that occurred
    pub fn get_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }

    /// Set current tool activity (tool name being called)
    pub fn set_tool_activity(&self, tool_name: Option<String>) {
        if let Ok(mut activity) = self.tool_activity.lock() {
            *activity = tool_name;
        }
    }

    /// Get current tool activity
    pub fn get_tool_activity(&self) -> Option<String> {
        self.tool_activity.lock().ok().and_then(|a| a.clone())
    }
}

impl Default for StreamingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Error type for RigAgent operations
#[derive(Debug)]
pub enum RigAgentError {
    ClientCreation(String),
    ToolSetCreation(String),
    Completion(String),
}

impl std::fmt::Display for RigAgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RigAgentError::ClientCreation(e) => write!(f, "Client creation error: {}", e),
            RigAgentError::ToolSetCreation(e) => write!(f, "Tool set creation error: {}", e),
            RigAgentError::Completion(e) => write!(f, "Completion error: {}", e),
        }
    }
}

impl std::error::Error for RigAgentError {}

/// Configuration for creating a RigAgent
pub struct RigAgentConfig {
    pub api_key: String,
    pub model: String,
    pub preamble: String,
    pub provider: Provider,
}

/// Supported providers
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Provider {
    Anthropic,
    OpenAI,
}

impl Default for Provider {
    fn default() -> Self {
        Provider::Anthropic
    }
}

/// Rig-Core Agent wrapper for the TUI.
///
/// This provides a high-level interface for multi-turn conversations
/// with automatic tool calling via rig-core's Agent abstraction.
pub struct RigAgent {
    /// The underlying rig-core agent (type-erased for flexibility)
    agent_type: AgentType,
    /// MCP client reference for tool routing
    mcp_client: McpClient,
}

/// Type-erased agent to handle different providers
enum AgentType {
    Anthropic(Agent<WasiAnthropicModel>),
    OpenAI(Agent<WasiOpenAIModel>),
}

/// Build a ToolSet with all our tools
fn build_tool_set(mcp_client: &McpClient) -> Result<ToolSet, String> {
    let mut tool_set = ToolSet::default();

    // Add MCP tools to the toolset
    for tool in McpToolAdapter::from_mcp_client(mcp_client)? {
        tool_set.add_tool(tool);
    }

    // Add local tools to the toolset
    for tool in LocalToolAdapter::all_local_tools() {
        tool_set.add_tool(tool);
    }

    Ok(tool_set)
}

/// Build the tool server handle with our tools
fn build_tool_server(
    mcp_client: &McpClient,
) -> Result<rig::tool::server::ToolServerHandle, String> {
    let tool_set = build_tool_set(mcp_client)?;

    // Start the tool server (this spawns the background task)
    let handle = ToolServer::new().run();

    // Add our toolset to the running server asynchronously
    // Using block_on since we're in sync context (WASI/JSPI handles this)
    block_on(handle.append_toolset(tool_set))
        .map_err(|e| format!("Failed to add tools to server: {}", e))?;

    Ok(handle)
}

impl RigAgent {
    /// Create a new RigAgent with Anthropic
    pub fn anthropic(
        api_key: &str,
        model: &str,
        preamble: &str,
        mcp_client: McpClient,
    ) -> Result<Self, RigAgentError> {
        let completion_model = WasiAnthropicModel::new(api_key, model)
            .map_err(|e| RigAgentError::ClientCreation(e.to_string()))?;

        let tool_handle = build_tool_server(&mcp_client).map_err(RigAgentError::ToolSetCreation)?;

        let agent = rig::agent::AgentBuilder::new(completion_model)
            .preamble(preamble)
            .tool_server_handle(tool_handle)
            .build();

        Ok(Self {
            agent_type: AgentType::Anthropic(agent),
            mcp_client,
        })
    }

    /// Create a new RigAgent with Anthropic and a custom base URL
    pub fn anthropic_with_base_url(
        api_key: &str,
        model: &str,
        base_url: &str,
        preamble: &str,
        mcp_client: McpClient,
    ) -> Result<Self, RigAgentError> {
        let completion_model = WasiAnthropicModel::with_base_url(api_key, model, base_url)
            .map_err(|e| RigAgentError::ClientCreation(e.to_string()))?;

        let tool_handle = build_tool_server(&mcp_client).map_err(RigAgentError::ToolSetCreation)?;

        let agent = rig::agent::AgentBuilder::new(completion_model)
            .preamble(preamble)
            .tool_server_handle(tool_handle)
            .build();

        Ok(Self {
            agent_type: AgentType::Anthropic(agent),
            mcp_client,
        })
    }

    /// Create a new RigAgent with OpenAI
    pub fn openai(
        api_key: &str,
        model: &str,
        preamble: &str,
        mcp_client: McpClient,
    ) -> Result<Self, RigAgentError> {
        let completion_model = WasiOpenAIModel::new(api_key, model)
            .map_err(|e| RigAgentError::ClientCreation(e.to_string()))?;

        let tool_handle = build_tool_server(&mcp_client).map_err(RigAgentError::ToolSetCreation)?;

        let agent = rig::agent::AgentBuilder::new(completion_model)
            .preamble(preamble)
            .tool_server_handle(tool_handle)
            .build();

        Ok(Self {
            agent_type: AgentType::OpenAI(agent),
            mcp_client,
        })
    }

    /// Create a new RigAgent with OpenAI-compatible API and custom base URL
    ///
    /// This is useful for Ollama, Groq, vLLM, and other OpenAI-compatible providers.
    pub fn openai_with_base_url(
        api_key: &str,
        model: &str,
        base_url: &str,
        preamble: &str,
        mcp_client: McpClient,
    ) -> Result<Self, RigAgentError> {
        let completion_model = WasiOpenAIModel::with_base_url(api_key, model, base_url)
            .map_err(|e| RigAgentError::ClientCreation(e.to_string()))?;

        let tool_handle = build_tool_server(&mcp_client).map_err(RigAgentError::ToolSetCreation)?;

        let agent = rig::agent::AgentBuilder::new(completion_model)
            .preamble(preamble)
            .tool_server_handle(tool_handle)
            .build();

        Ok(Self {
            agent_type: AgentType::OpenAI(agent),
            mcp_client,
        })
    }

    /// Create a RigAgent from provider configuration
    ///
    /// # Arguments
    /// * `api_key` - API key for the provider
    /// * `model` - Model name
    /// * `api_format` - Either "anthropic" or "openai"
    /// * `base_url` - Optional custom base URL
    /// * `preamble` - System prompt
    /// * `mcp_client` - MCP client for tool calling
    pub fn from_config(
        api_key: &str,
        model: &str,
        api_format: &str,
        base_url: Option<&str>,
        preamble: &str,
        mcp_client: McpClient,
    ) -> Result<Self, RigAgentError> {
        match (api_format, base_url) {
            ("anthropic", None) => Self::anthropic(api_key, model, preamble, mcp_client),
            ("anthropic", Some(url)) => {
                Self::anthropic_with_base_url(api_key, model, url, preamble, mcp_client)
            }
            (_, None) => Self::openai(api_key, model, preamble, mcp_client),
            (_, Some(url)) => Self::openai_with_base_url(api_key, model, url, preamble, mcp_client),
        }
    }

    /// Create a default Anthropic agent with Claude Haiku
    pub fn default_anthropic(
        api_key: &str,
        preamble: &str,
        mcp_client: McpClient,
    ) -> Result<Self, RigAgentError> {
        Self::anthropic(api_key, "claude-haiku-4-5-20251001", preamble, mcp_client)
    }

    /// Simple prompt (no history, non-streaming)
    ///
    /// This uses JSPI to bridge async to sync execution.
    pub fn prompt(&self, message: &str) -> Result<String, RigAgentError> {
        let result = match &self.agent_type {
            AgentType::Anthropic(agent) => block_on(agent.prompt(message).into_future()),
            AgentType::OpenAI(agent) => block_on(agent.prompt(message).into_future()),
        };

        result.map_err(|e| RigAgentError::Completion(e.to_string()))
    }

    /// Prompt with multi-turn tool calling support
    ///
    /// This enables the agent to make multiple tool calls before responding.
    pub fn prompt_with_tools(
        &self,
        message: &str,
        max_turns: usize,
    ) -> Result<String, RigAgentError> {
        let result = match &self.agent_type {
            AgentType::Anthropic(agent) => {
                block_on(agent.prompt(message).multi_turn(max_turns).into_future())
            }
            AgentType::OpenAI(agent) => {
                block_on(agent.prompt(message).multi_turn(max_turns).into_future())
            }
        };

        result.map_err(|e| RigAgentError::Completion(e.to_string()))
    }

    /// Chat with history (non-streaming)
    ///
    /// Converts our message format to rig-core format.
    pub fn chat(&self, prompt: &str, history: Vec<ChatMessage>) -> Result<String, RigAgentError> {
        let rig_history: Vec<RigMessage> = history
            .into_iter()
            .map(|m| match m.role {
                ChatRole::User => RigMessage::user(m.content),
                ChatRole::Assistant => RigMessage::assistant(m.content),
            })
            .collect();

        let result = match &self.agent_type {
            AgentType::Anthropic(agent) => block_on(agent.chat(prompt, rig_history)),
            AgentType::OpenAI(agent) => block_on(agent.chat(prompt, rig_history)),
        };

        result.map_err(|e| RigAgentError::Completion(e.to_string()))
    }

    /// Get the MCP client for direct tool calls if needed
    pub fn mcp_client(&self) -> &McpClient {
        &self.mcp_client
    }

    /// Start streaming a prompt response
    ///
    /// This spawns an async task to process the stream and writes chunks
    /// to the provided StreamingBuffer. The caller should poll the buffer
    /// for new content during their render loop.
    ///
    /// Returns immediately - the streaming happens in the background.
    pub fn stream_prompt_with_buffer(&self, message: &str, buffer: StreamingBuffer) {
        let message = message.to_string();

        // Clone agent for the async block
        match &self.agent_type {
            AgentType::Anthropic(agent) => {
                let agent = agent.clone();
                let buffer = buffer.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    Self::run_stream_anthropic(agent, message, buffer).await;
                });
            }
            AgentType::OpenAI(agent) => {
                let agent = agent.clone();
                let buffer = buffer.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    Self::run_stream_openai(agent, message, buffer).await;
                });
            }
        }
    }

    /// Internal: Run the Anthropic streaming loop
    async fn run_stream_anthropic(
        agent: Agent<WasiAnthropicModel>,
        message: String,
        buffer: StreamingBuffer,
    ) {
        use rig::agent::MultiTurnStreamItem;
        use rig::streaming::StreamedAssistantContent;

        // Use multi_turn(5) to enable tool execution during streaming
        let mut stream = agent.stream_prompt(&message).multi_turn(5).await;

        while let Some(result) = stream.next().await {
            // Check for cancellation
            if buffer.is_cancelled() {
                break;
            }

            match result {
                Ok(item) => {
                    match item {
                        MultiTurnStreamItem::StreamAssistantItem(content) => {
                            match content {
                                StreamedAssistantContent::Text(text) => {
                                    // Clear tool activity when text arrives
                                    buffer.set_tool_activity(None);
                                    buffer.append(text.text.as_str());
                                }
                                StreamedAssistantContent::ToolCall(tool_call) => {
                                    // Show tool is being called
                                    let tool_name = tool_call.function.name.clone();
                                    buffer.set_tool_activity(Some(format!(
                                        "🔧 Calling {}...",
                                        tool_name
                                    )));
                                }
                                _ => {
                                    // ToolCallDelta, Reasoning, etc.
                                }
                            }
                        }
                        _ => {
                            // Turn completed - clear tool activity
                            buffer.set_tool_activity(None);
                        }
                    }
                }
                Err(e) => {
                    buffer.set_error(e.to_string());
                    return;
                }
            }
        }

        buffer.set_complete();
    }

    /// Internal: Run the OpenAI streaming loop
    async fn run_stream_openai(
        agent: Agent<WasiOpenAIModel>,
        message: String,
        buffer: StreamingBuffer,
    ) {
        use rig::agent::MultiTurnStreamItem;
        use rig::streaming::StreamedAssistantContent;

        // Use multi_turn(5) to enable tool execution during streaming
        let mut stream = agent.stream_prompt(&message).multi_turn(5).await;

        while let Some(result) = stream.next().await {
            // Check for cancellation
            if buffer.is_cancelled() {
                break;
            }

            match result {
                Ok(item) => {
                    match item {
                        MultiTurnStreamItem::StreamAssistantItem(content) => {
                            match content {
                                StreamedAssistantContent::Text(text) => {
                                    // Clear tool activity when text arrives
                                    buffer.set_tool_activity(None);
                                    buffer.append(text.text.as_str());
                                }
                                StreamedAssistantContent::ToolCall(tool_call) => {
                                    // Show tool is being called
                                    let tool_name = tool_call.function.name.clone();
                                    buffer.set_tool_activity(Some(format!(
                                        "🔧 Calling {}...",
                                        tool_name
                                    )));
                                }
                                _ => {
                                    // ToolCallDelta, Reasoning, etc.
                                }
                            }
                        }
                        _ => {
                            // Turn completed - clear tool activity
                            buffer.set_tool_activity(None);
                        }
                    }
                }
                Err(e) => {
                    buffer.set_error(e.to_string());
                    return;
                }
            }
        }

        buffer.set_complete();
    }
}

/// Simple chat message for the RigAgent interface
#[derive(Clone, Debug)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

/// Chat role
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChatRole {
    User,
    Assistant,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::User,
            content: content.into(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Assistant,
            content: content.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chat_message_creation() {
        let msg = ChatMessage::user("Hello");
        assert_eq!(msg.role, ChatRole::User);
        assert_eq!(msg.content, "Hello");
    }
}
