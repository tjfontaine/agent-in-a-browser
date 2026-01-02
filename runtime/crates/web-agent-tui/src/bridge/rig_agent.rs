//! Rig-Core Agent Wrapper
//!
//! High-level agent abstraction using rig-core's Agent for multi-turn
//! conversations with automatic tool calling.

use rig::agent::Agent;
use rig::completion::{Chat, Message as RigMessage, Prompt};
use rig::streaming::StreamingPrompt;
use rig::tool::server::ToolServer;
use std::future::{Future, IntoFuture};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use super::mcp_client::McpClient;
use super::wasi_completion_model::{WasiAnthropicModel, WasiOpenAIModel};

/// WASIP2-compatible block_on implementation.
///
/// Unlike `futures::executor::block_on`, this doesn't use thread parking
/// which fails in WASM. Instead, it polls with a noop waker and relies on
/// JSPI to suspend the WASM stack during blocking operations.
///
/// IMPORTANT: This only works in WASIP2/JSPI environments where blocking
/// WASI calls (like poll.block() and blocking_read) suspend the stack.
fn wasm_block_on<F: Future>(mut future: F) -> F::Output {
    use futures::task::noop_waker;

    let waker = noop_waker();
    let mut cx = Context::from_waker(&waker);

    // SAFETY: We're pinning a local future that won't be moved
    let mut future = unsafe { Pin::new_unchecked(&mut future) };

    let mut pending_count = 0u32;
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(result) => return result,
            Poll::Pending => {
                pending_count += 1;
                if pending_count > 50 {
                    panic!(
                        "[wasm_block_on] DEADLOCK DETECTED: future returned Pending {} times. \
                         This indicates an await point that cannot be resolved without a working waker. \
                         Check for tokio::sync primitives or other async mechanisms that require an executor.",
                        pending_count
                    );
                }
                // In WASIP2/JSPI, blocking WASI calls inside the future will
                // suspend the WASM stack. When they return, we continue polling.
                // If we get Pending without a blocking call, we need to yield.
                // Use a short sleep to avoid busy-spinning.
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }
}

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

/// Result of polling the stream once
#[derive(Debug)]
pub enum PollResult {
    /// Got a chunk, more data expected
    Chunk,
    /// No data available yet, still pending
    Pending,
    /// Stream completed successfully
    Complete,
    /// Stream ended with an error
    Error(String),
}

/// Active streaming session that can be polled once per tick.
/// This allows the TUI to render between stream chunks.
pub struct ActiveStream {
    /// The underlying stream state
    state: ActiveStreamState,
    /// Buffer to accumulate content
    buffer: StreamingBuffer,
}

/// State machine for stream lifecycle
enum ActiveStreamState {
    /// Still connecting to the API (polling the stream creation future)
    ConnectingAnthropic(
        std::pin::Pin<
            Box<
                dyn std::future::Future<
                    Output = rig::agent::prompt_request::streaming::StreamingResult<
                        super::wasi_completion_model::AnthropicStreamingResponse,
                    >,
                >,
            >,
        >,
    ),
    ConnectingOpenAI(
        std::pin::Pin<
            Box<
                dyn std::future::Future<
                    Output = rig::agent::prompt_request::streaming::StreamingResult<
                        super::wasi_completion_model::OpenAIStreamingResponse,
                    >,
                >,
            >,
        >,
    ),
    /// Stream is ready, polling for chunks
    StreamingAnthropic(
        rig::agent::prompt_request::streaming::StreamingResult<
            super::wasi_completion_model::AnthropicStreamingResponse,
        >,
    ),
    StreamingOpenAI(
        rig::agent::prompt_request::streaming::StreamingResult<
            super::wasi_completion_model::OpenAIStreamingResponse,
        >,
    ),
}

impl ActiveStream {
    /// Create a new ActiveStream from a RigAgent and message.
    /// Returns immediately - actual connection happens during poll_once().
    pub fn start(agent: &RigAgent, message: &str) -> Self {
        use std::future::IntoFuture;

        let buffer = StreamingBuffer::new();
        let message = message.to_string();

        let state = match &agent.agent_type {
            AgentType::Anthropic(agent) => {
                let future = agent.stream_prompt(&message).multi_turn(5).into_future();
                ActiveStreamState::ConnectingAnthropic(Box::pin(future))
            }
            AgentType::OpenAI(agent) => {
                let future = agent.stream_prompt(&message).multi_turn(5).into_future();
                ActiveStreamState::ConnectingOpenAI(Box::pin(future))
            }
        };

        ActiveStream { state, buffer }
    }

    /// Get a clone of the buffer for reading content
    pub fn buffer(&self) -> StreamingBuffer {
        self.buffer.clone()
    }

    /// Poll the stream once, process any available item, and return.
    /// This allows the caller to render UI between polls.
    pub fn poll_once(&mut self) -> PollResult {
        use futures::Stream;
        use rig::agent::MultiTurnStreamItem;
        use rig::streaming::StreamedAssistantContent;
        use std::future::Future;
        use std::task::Poll;

        // Check if cancelled
        if self.buffer.is_cancelled() {
            self.buffer.set_complete();
            return PollResult::Complete;
        }

        let waker = futures::task::noop_waker();
        let mut cx = Context::from_waker(&waker);

        // Helper to process a stream item (same for both providers)
        fn process_item<R>(item: MultiTurnStreamItem<R>, buffer: &StreamingBuffer) {
            match item {
                MultiTurnStreamItem::StreamAssistantItem(content) => match content {
                    StreamedAssistantContent::Text(text) => {
                        buffer.set_tool_activity(None);
                        buffer.append(&text.text);
                    }
                    StreamedAssistantContent::ToolCall(tool_call) => {
                        let tool_name = tool_call.function.name.clone();
                        buffer.set_tool_activity(Some(format!("🔧 Calling {}...", tool_name)));
                    }
                    _ => {}
                },
                _ => {
                    buffer.set_tool_activity(None);
                }
            }
        }

        // Handle state machine - first poll connection, then poll stream
        // Use a placeholder for state transitions
        enum Transition {
            None,
            ToStreamingAnthropic(
                rig::agent::prompt_request::streaming::StreamingResult<
                    super::wasi_completion_model::AnthropicStreamingResponse,
                >,
            ),
            ToStreamingOpenAI(
                rig::agent::prompt_request::streaming::StreamingResult<
                    super::wasi_completion_model::OpenAIStreamingResponse,
                >,
            ),
        }

        let (result, transition) = match &mut self.state {
            ActiveStreamState::ConnectingAnthropic(future) => {
                match future.as_mut().poll(&mut cx) {
                    Poll::Ready(stream) => {
                        // Connection complete, transition to streaming
                        (
                            PollResult::Pending,
                            Transition::ToStreamingAnthropic(stream),
                        )
                    }
                    Poll::Pending => (PollResult::Pending, Transition::None),
                }
            }
            ActiveStreamState::ConnectingOpenAI(future) => {
                match future.as_mut().poll(&mut cx) {
                    Poll::Ready(stream) => {
                        // Connection complete, transition to streaming
                        (PollResult::Pending, Transition::ToStreamingOpenAI(stream))
                    }
                    Poll::Pending => (PollResult::Pending, Transition::None),
                }
            }
            ActiveStreamState::StreamingAnthropic(stream) => {
                let result = match stream.as_mut().poll_next(&mut cx) {
                    Poll::Ready(Some(Ok(item))) => {
                        process_item(item, &self.buffer);
                        PollResult::Chunk
                    }
                    Poll::Ready(Some(Err(e))) => {
                        self.buffer.set_error(e.to_string());
                        self.buffer.set_complete();
                        PollResult::Error(e.to_string())
                    }
                    Poll::Ready(None) => {
                        self.buffer.set_complete();
                        PollResult::Complete
                    }
                    Poll::Pending => PollResult::Pending,
                };
                (result, Transition::None)
            }
            ActiveStreamState::StreamingOpenAI(stream) => {
                let result = match stream.as_mut().poll_next(&mut cx) {
                    Poll::Ready(Some(Ok(item))) => {
                        process_item(item, &self.buffer);
                        PollResult::Chunk
                    }
                    Poll::Ready(Some(Err(e))) => {
                        self.buffer.set_error(e.to_string());
                        self.buffer.set_complete();
                        PollResult::Error(e.to_string())
                    }
                    Poll::Ready(None) => {
                        self.buffer.set_complete();
                        PollResult::Complete
                    }
                    Poll::Pending => PollResult::Pending,
                };
                (result, Transition::None)
            }
        };

        // Apply state transition if needed
        match transition {
            Transition::None => {}
            Transition::ToStreamingAnthropic(stream) => {
                self.state = ActiveStreamState::StreamingAnthropic(stream);
            }
            Transition::ToStreamingOpenAI(stream) => {
                self.state = ActiveStreamState::StreamingOpenAI(stream);
            }
        }

        result
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

/// Build the tool server handle with our tools
///
/// Uses rig_tools::build_tool_set to create ToolDyn adapters, then adds them
/// before calling run() - this avoids block_on deadlock.
fn build_tool_server(
    mcp_client: &McpClient,
) -> Result<rig::tool::server::ToolServerHandle, String> {
    let tool_set = super::rig_tools::build_tool_set(mcp_client)?;

    // Add tools BEFORE run() to avoid block_on deadlock
    // (run() spawns a background task that would deadlock with block_on)
    let handle = ToolServer::new().add_tools(tool_set).run();

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
            AgentType::Anthropic(agent) => wasm_block_on(agent.prompt(message).into_future()),
            AgentType::OpenAI(agent) => wasm_block_on(agent.prompt(message).into_future()),
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
                wasm_block_on(agent.prompt(message).multi_turn(max_turns).into_future())
            }
            AgentType::OpenAI(agent) => {
                wasm_block_on(agent.prompt(message).multi_turn(max_turns).into_future())
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
            AgentType::Anthropic(agent) => wasm_block_on(agent.chat(prompt, rig_history)),
            AgentType::OpenAI(agent) => wasm_block_on(agent.chat(prompt, rig_history)),
        };

        result.map_err(|e| RigAgentError::Completion(e.to_string()))
    }

    /// Get the MCP client for direct tool calls if needed
    pub fn mcp_client(&self) -> &McpClient {
        &self.mcp_client
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
