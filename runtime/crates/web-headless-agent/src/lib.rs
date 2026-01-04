//! Headless Agent - Embeddable agent without TUI dependencies
//!
//! This crate provides a WASM component that exposes AgentCore via WIT interface
//! for use from JavaScript. No terminal I/O dependencies.

use std::collections::HashMap;
use std::sync::Mutex;

// Generate WIT bindings - expands to module with types and traits
wit_bindgen::generate!({
    world: "headless-agent",
    path: "wit",
    generate_all,
});

// ============================================================================
// Agent Storage
// ============================================================================

/// Global agent storage - maps handles to agent instances
static AGENTS: Mutex<Option<AgentStorage>> = Mutex::new(None);

struct AgentStorage {
    next_handle: u32,
    agents: HashMap<u32, HeadlessAgent>,
}

impl AgentStorage {
    fn new() -> Self {
        Self {
            next_handle: 1,
            agents: HashMap::new(),
        }
    }

    fn insert(&mut self, agent: HeadlessAgent) -> u32 {
        let handle = self.next_handle;
        self.next_handle += 1;
        self.agents.insert(handle, agent);
        handle
    }

    fn get(&self, handle: u32) -> Option<&HeadlessAgent> {
        self.agents.get(&handle)
    }

    fn get_mut(&mut self, handle: u32) -> Option<&mut HeadlessAgent> {
        self.agents.get_mut(&handle)
    }

    fn remove(&mut self, handle: u32) -> Option<HeadlessAgent> {
        self.agents.remove(&handle)
    }
}

fn with_storage<F, R>(f: F) -> R
where
    F: FnOnce(&mut AgentStorage) -> R,
{
    let mut guard = AGENTS.lock().unwrap();
    let storage = guard.get_or_insert_with(AgentStorage::new);
    f(storage)
}

// ============================================================================
// Headless Agent Implementation
// ============================================================================

/// A headless agent instance
struct HeadlessAgent {
    config: AgentConfig,
    messages: Vec<Message>,
    events: std::collections::VecDeque<AgentEvent>,
    is_streaming: bool,
}

impl HeadlessAgent {
    fn new(config: AgentConfig) -> Self {
        Self {
            config,
            messages: Vec::new(),
            events: std::collections::VecDeque::new(),
            is_streaming: false,
        }
    }

    fn send(&mut self, message: &str) -> Result<(), String> {
        if self.is_streaming {
            return Err("Already streaming".to_string());
        }

        // Add user message to history
        self.messages.push(Message {
            role: MessageRole::User,
            content: message.to_string(),
        });

        // Emit stream start
        self.events.push_back(AgentEvent::StreamStart);
        self.is_streaming = true;

        // TODO: Actually start the stream with rig-core
        // For now, emit a mock response based on provider/model config
        let response = format!(
            "Hello from {} using {}! I received your message: \"{}\"",
            self.config.provider, self.config.model, message
        );

        self.events
            .push_back(AgentEvent::StreamChunk(response.clone()));
        self.events
            .push_back(AgentEvent::StreamComplete(response.clone()));

        // Add assistant message
        self.messages.push(Message {
            role: MessageRole::Assistant,
            content: response,
        });

        self.is_streaming = false;
        self.events.push_back(AgentEvent::Ready);

        Ok(())
    }

    fn poll(&mut self) -> Option<AgentEvent> {
        self.events.pop_front()
    }

    fn cancel(&mut self) {
        if self.is_streaming {
            self.is_streaming = false;
            self.events.clear();
            self.events.push_back(AgentEvent::Ready);
        }
    }

    fn get_history(&self) -> Vec<Message> {
        self.messages.clone()
    }

    fn clear_history(&mut self) {
        self.messages.clear();
    }
}

// ============================================================================
// WIT Export Implementation
// ============================================================================

struct Component;

impl Guest for Component {
    fn create(config: AgentConfig) -> Result<AgentHandle, String> {
        let agent = HeadlessAgent::new(config);
        let handle = with_storage(|s| s.insert(agent));
        Ok(handle)
    }

    fn destroy(handle: AgentHandle) {
        with_storage(|s| {
            s.remove(handle);
        });
    }

    fn send(handle: AgentHandle, message: String) -> Result<(), String> {
        with_storage(|s| {
            let agent = s.get_mut(handle).ok_or("Invalid handle")?;
            agent.send(&message)
        })
    }

    fn poll(handle: AgentHandle) -> Option<AgentEvent> {
        with_storage(|s| s.get_mut(handle).and_then(|a| a.poll()))
    }

    fn cancel(handle: AgentHandle) {
        with_storage(|s| {
            if let Some(agent) = s.get_mut(handle) {
                agent.cancel();
            }
        });
    }

    fn get_history(handle: AgentHandle) -> Vec<Message> {
        with_storage(|s| s.get(handle).map(|a| a.get_history()).unwrap_or_default())
    }

    fn clear_history(handle: AgentHandle) {
        with_storage(|s| {
            if let Some(agent) = s.get_mut(handle) {
                agent.clear_history();
            }
        });
    }
}

export!(Component);
