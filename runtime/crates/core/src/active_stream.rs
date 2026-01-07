//! Active Streaming - Shared async polling infrastructure for multi-turn agent execution
//!
//! This module provides the async stream handling that properly supports rig's multi-turn
//! tool calling loop. Both TUI and headless agents use this for consistent behavior.

use futures::StreamExt;
use rig::agent::MultiTurnStreamItem;
use rig::streaming::StreamedAssistantContent;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

/// Shared buffer for streaming content
///
/// This allows async streaming to write chunks while consumers read them.
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
    /// Current tool activity (tool name being called)
    tool_activity: Arc<Mutex<Option<String>>>,
    /// Last tool result (tool_name, result, is_error)
    last_tool_result: Arc<Mutex<Option<(String, String, bool)>>>,
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
            last_tool_result: Arc::new(Mutex::new(None)),
        }
    }

    /// Create with initial content
    pub fn with_content(content: String) -> Self {
        let buffer = Self::new();
        if let Ok(mut lock) = buffer.content.lock() {
            *lock = content;
        }
        buffer
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

    /// Set last tool result (tool_name, result, is_error)
    pub fn set_tool_result(&self, result: Option<(String, String, bool)>) {
        if let Ok(mut tr) = self.last_tool_result.lock() {
            *tr = result;
        }
    }

    /// Get and clear last tool result
    pub fn take_tool_result(&self) -> Option<(String, String, bool)> {
        self.last_tool_result
            .lock()
            .ok()
            .and_then(|mut tr| tr.take())
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

/// Type-erased stream item - extracts only what we need from MultiTurnStreamItem<R>
#[derive(Debug, Clone)]
pub enum StreamItem {
    /// Text content from assistant
    Text(String),
    /// Tool call in progress
    ToolCall { name: String },
    /// Tool result received
    ToolResult {
        tool_name: String,
        result: String,
        is_error: bool,
    },
    /// Final response
    Final,
    /// Other content we don't handle
    Other,
}

impl StreamItem {
    /// Convert from any MultiTurnStreamItem<R> - erases the R type
    pub fn from_multi_turn<R>(item: MultiTurnStreamItem<R>) -> Self {
        use rig::message::ToolResultContent;
        use rig::streaming::StreamedUserContent;

        match item {
            MultiTurnStreamItem::StreamAssistantItem(content) => match content {
                StreamedAssistantContent::Text(text) => StreamItem::Text(text.text),
                StreamedAssistantContent::ToolCall(tc) => StreamItem::ToolCall {
                    name: tc.function.name,
                },
                StreamedAssistantContent::Final(_) => StreamItem::Final,
                _ => StreamItem::Other,
            },
            MultiTurnStreamItem::StreamUserItem(StreamedUserContent::ToolResult(tr)) => {
                // Extract text from tool result content
                let result_text = tr
                    .content
                    .iter()
                    .filter_map(|c| match c {
                        ToolResultContent::Text(text) => Some(text.text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                // Check if result looks like an error
                let is_error = result_text.contains("error")
                    || result_text.contains("Error")
                    || result_text.contains("ERROR");
                StreamItem::ToolResult {
                    tool_name: tr.id.clone(), // id is the tool call id, not name - we'll fix this in buffer
                    result: result_text,
                    is_error,
                }
            }
            MultiTurnStreamItem::FinalResponse(_) => StreamItem::Final,
            _ => StreamItem::Other,
        }
    }
}

/// Type-erased streaming result
pub type ErasedStreamResult =
    Result<StreamItem, rig::agent::prompt_request::streaming::StreamingError>;

/// Type-erased stream
pub type ErasedStream = std::pin::Pin<Box<dyn futures::Stream<Item = ErasedStreamResult>>>;

/// Type-erased future that produces an erased stream
pub type ErasedConnectFuture = std::pin::Pin<Box<dyn std::future::Future<Output = ErasedStream>>>;

/// State machine for stream lifecycle
pub enum ActiveStreamState {
    /// Still connecting to the API
    Connecting(ErasedConnectFuture),
    /// Stream is ready, polling for chunks
    Streaming(ErasedStream),
}

/// Active streaming session that can be polled once per tick.
///
/// This allows callers to process other work between stream chunks,
/// which is essential for UI rendering and event handling.
pub struct ActiveStream {
    /// The underlying stream state
    state: ActiveStreamState,
    /// Buffer to accumulate content
    buffer: StreamingBuffer,
}

impl ActiveStream {
    /// Create a new ActiveStream from an already-constructed state.
    ///
    /// This is the low-level constructor. Use the `start_*` helper methods
    /// for specific agent types if available.
    pub fn from_state(state: ActiveStreamState, buffer: StreamingBuffer) -> Self {
        ActiveStream { state, buffer }
    }

    /// Create from an erased connecting future
    pub fn from_future(future: ErasedConnectFuture) -> Self {
        Self::from_state(
            ActiveStreamState::Connecting(future),
            StreamingBuffer::new(),
        )
    }

    /// Create from an erased connecting future with initial content
    pub fn from_future_with_content(future: ErasedConnectFuture, initial_content: String) -> Self {
        Self::from_state(
            ActiveStreamState::Connecting(future),
            StreamingBuffer::with_content(initial_content),
        )
    }

    /// Get a clone of the buffer for reading content
    pub fn buffer(&self) -> StreamingBuffer {
        self.buffer.clone()
    }

    /// Poll the stream once, process any available item, and return.
    ///
    /// This allows the caller to render UI or handle events between polls.
    /// The multi-turn tool loop continues across multiple polls.
    pub fn poll_once(&mut self) -> PollResult {
        // Check if cancelled
        if self.buffer.is_cancelled() {
            eprintln!("[ActiveStream] Cancelled, returning Complete");
            self.buffer.set_complete();
            return PollResult::Complete;
        }

        let waker = futures::task::noop_waker();
        let mut cx = Context::from_waker(&waker);

        // Handle state machine
        enum Transition {
            None,
            ToStreaming(ErasedStream),
        }

        let (result, transition) = match &mut self.state {
            ActiveStreamState::Connecting(future) => {
                eprintln!("[ActiveStream] State: Connecting");
                match future.as_mut().poll(&mut cx) {
                    Poll::Ready(stream) => {
                        eprintln!("[ActiveStream] Connecting -> Ready, transitioning");
                        (PollResult::Pending, Transition::ToStreaming(stream))
                    }
                    Poll::Pending => {
                        eprintln!("[ActiveStream] Connecting -> Pending");
                        (PollResult::Pending, Transition::None)
                    }
                }
            }
            ActiveStreamState::Streaming(stream) => {
                let result = match stream.as_mut().poll_next(&mut cx) {
                    Poll::Ready(Some(Ok(item))) => {
                        // Process the type-erased item
                        match item {
                            StreamItem::Text(text) => {
                                eprintln!("[ActiveStream] Text: {} bytes", text.len());
                                self.buffer.set_tool_activity(None);
                                self.buffer.append(&text);
                            }
                            StreamItem::ToolCall { name } => {
                                eprintln!("[ActiveStream] ToolCall: {}", name);
                                self.buffer
                                    .set_tool_activity(Some(format!("🔧 Calling {}...", name)));
                            }
                            StreamItem::ToolResult {
                                tool_name,
                                result,
                                is_error,
                            } => {
                                eprintln!(
                                    "[ActiveStream] ToolResult received: {} bytes",
                                    result.len()
                                );
                                // Store the tool result for agent_core to emit
                                self.buffer
                                    .set_tool_result(Some((tool_name, result, is_error)));
                                self.buffer.set_tool_activity(None);
                            }
                            StreamItem::Final => {
                                eprintln!("[ActiveStream] Final received");
                                self.buffer.set_tool_activity(None);
                            }
                            StreamItem::Other => {
                                eprintln!("[ActiveStream] Other received");
                                self.buffer.set_tool_activity(None);
                            }
                        }
                        PollResult::Chunk
                    }
                    Poll::Ready(Some(Err(e))) => {
                        eprintln!("[ActiveStream] Error: {}", e);
                        self.buffer.set_error(e.to_string());
                        self.buffer.set_complete();
                        PollResult::Error(e.to_string())
                    }
                    Poll::Ready(None) => {
                        eprintln!("[ActiveStream] Stream ended (None)");
                        self.buffer.set_complete();
                        PollResult::Complete
                    }
                    Poll::Pending => {
                        eprintln!("[ActiveStream] Stream Pending");
                        PollResult::Pending
                    }
                };
                (result, Transition::None)
            }
        };

        // Apply state transition if needed
        if let Transition::ToStreaming(stream) = transition {
            eprintln!("[ActiveStream] Transitioning to Streaming state");
            self.state = ActiveStreamState::Streaming(stream);
        }

        result
    }
}

/// Helper to create an erased stream from a multi-turn stream
pub fn erase_stream<S, R>(stream: S) -> ErasedStream
where
    S: futures::Stream<
            Item = Result<
                MultiTurnStreamItem<R>,
                rig::agent::prompt_request::streaming::StreamingError,
            >,
        > + 'static,
{
    Box::pin(stream.map(|r| r.map(StreamItem::from_multi_turn)))
}
