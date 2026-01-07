//! Rig-Core Agent Utilities
//!
//! Shared utilities for working with rig-core agents, including
//! stream processing for multi-turn conversations with tool calling.

use futures::StreamExt;
use rig::agent::MultiTurnStreamItem;

use crate::active_stream::StreamItem;
use crate::wasm_async::wasm_block_on;

/// Trait for handling stream events during agent execution.
///
/// Each component implements this to emit events in their WIT-specific format.
pub trait StreamEventHandler {
    /// Called when a text chunk is received
    fn on_text(&mut self, text: &str);

    /// Called when a tool is being called
    fn on_tool_call(&mut self, tool_name: &str);

    /// Called when a tool result is received
    fn on_tool_result(&mut self);
}

/// Process a multi-turn stream, calling the handler for each event.
/// Returns the accumulated text content.
pub fn process_stream<S, R, H>(mut stream: S, handler: &mut H) -> Result<String, String>
where
    S: futures::Stream<
            Item = Result<
                MultiTurnStreamItem<R>,
                rig::agent::prompt_request::streaming::StreamingError,
            >,
        > + Unpin,
    H: StreamEventHandler,
{
    let mut content = String::new();

    loop {
        match wasm_block_on(stream.next()) {
            Some(Ok(item)) => match StreamItem::from_multi_turn(item) {
                StreamItem::Text(text) => {
                    content.push_str(&text);
                    handler.on_text(&text);
                }
                StreamItem::ToolCall { name } => {
                    handler.on_tool_call(&name);
                }
                StreamItem::ToolResult { .. } => {
                    handler.on_tool_result();
                }
                StreamItem::Final => {
                    break;
                }
                StreamItem::Other => {}
            },
            Some(Err(e)) => {
                return Err(format!("Stream error: {}", e));
            }
            None => break,
        }
    }

    Ok(content)
}

/// Collector that accumulates events for later processing.
///
/// Useful when events need to be collected and emitted after stream processing.
#[derive(Default)]
pub struct EventCollector {
    pub chunks: Vec<String>,
    pub tool_calls: Vec<String>,
    pub tool_results: usize,
}

impl StreamEventHandler for EventCollector {
    fn on_text(&mut self, text: &str) {
        self.chunks.push(text.to_string());
    }

    fn on_tool_call(&mut self, tool_name: &str) {
        self.tool_calls.push(tool_name.to_string());
    }

    fn on_tool_result(&mut self) {
        self.tool_results += 1;
    }
}
