//! Headless Agent - Embeddable agent without TUI dependencies
//!
//! This crate provides a WASM component that exposes the agent via WIT interface
//! for use from JavaScript. Uses rig-core for actual LLM calls with MCP tool support.

use std::collections::HashMap;
use std::sync::Arc;

mod bridge;

#[allow(warnings)]
mod bindings;

use bindings::Guest;
use rig::agent::Agent;
use rig::completion::{Message as RigMessage, Prompt};
use rig::streaming::StreamingChat;
use rig::tool::server::ToolServer;
use std::future::IntoFuture;

use bridge::mcp_client::SandboxMcpClient;
use bridge::wasi_completion_model::{
    create_anthropic_client, create_gemini_client, create_openai_client, AnthropicModel,
    GeminiModel, OpenAIModel,
};

// ============================================================================
// Agent Storage - Uses thread_local for single-threaded WASM (no Send needed)
// ============================================================================

use std::cell::RefCell;

thread_local! {
    static AGENTS: RefCell<AgentStorage> = RefCell::new(AgentStorage::new());
}

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
    AGENTS.with(|storage| f(&mut storage.borrow_mut()))
}

// ============================================================================
// Agent Types - use bindings for WIT types
// ============================================================================

use bindings::{AgentConfig, AgentEvent, AgentHandle, Message, MessageRole};

/// Build tool server using agent_bridge's McpToolAdapter
fn build_tool_server(
    mcp_client: Arc<SandboxMcpClient>,
) -> Result<rig::tool::server::ToolServerHandle, String> {
    let tool_set = agent_bridge::build_tool_set(mcp_client)?;
    let handle = ToolServer::new().add_tools(tool_set).run();
    Ok(handle)
}

/// Default system preamble for the headless agent
const DEFAULT_PREAMBLE: &str = r#"You are an autonomous coding agent that completes tasks by writing and executing code.

# CRITICAL RULES

1. COMPLETE THE ENTIRE TASK - do NOT stop after one step
2. After each tool call, CONTINUE to the next step immediately
3. When a plan has multiple steps, execute ALL of them

# Environment

You are running in a browser-based sandbox with:
- OPFS filesystem (persistent storage)
- tsx (TypeScript/JavaScript executor)
- HTTP fetch support

# Available Tools

- write_file: Write content to a file
- read_file: Read file contents
- run_command: Execute shell commands

# TypeScript Execution (tsx)

ALWAYS prefer single-file TypeScript for tasks. The tsx engine supports:

```typescript
// Direct execution - run with: tsx script.ts
console.log("Hello");  // Built-in console
await fetch(url);      // Built-in fetch

// ESM imports work:
import { z } from 'zod';  // Auto-fetches from esm.sh
```

## Build Pattern

For TypeScript projects, build into a SINGLE FILE:
1. Write a single .ts file with all code
2. Run it with: run_command "tsx myfile.ts"
3. DO NOT create package.json or tsconfig.json unless specifically asked

## Example Workflow

Task: "Build a calculator"
Step 1: write_file → calculator.ts (complete implementation + tests)
Step 2: run_command → "tsx calculator.ts"
Step 3: Report results

# Task Completion

- Execute ALL steps in order
- Show results after running code
- Confirm completion: "✓ Task complete"
"#;

/// Agent with tools (uses multi_turn for tool loop)
enum AgentWithTools {
    Anthropic(Agent<AnthropicModel>),
    OpenAI(Agent<OpenAIModel>),
    Gemini(Agent<GeminiModel>),
}

/// Simple agent without tools
enum SimpleAgent {
    Anthropic(Agent<AnthropicModel>),
    OpenAI(Agent<OpenAIModel>),
    Gemini(Agent<GeminiModel>),
}

/// The agent can either have tools or not
enum AgentProvider {
    WithTools {
        agent: AgentWithTools,
        mcp_client: Arc<SandboxMcpClient>,
    },
    Simple(SimpleAgent),
}

struct HeadlessAgent {
    provider: AgentProvider,
    messages: Vec<Message>,
    events: std::collections::VecDeque<AgentEvent>,
    is_streaming: bool,
    max_turns: usize,
}

impl HeadlessAgent {
    fn new(config: AgentConfig) -> Result<Self, String> {
        let base_url = config.base_url.as_deref();

        // Build preamble: override completely OR add to default
        let preamble = if let Some(override_preamble) = &config.preamble_override {
            // Complete override - use only the override text
            override_preamble.clone()
        } else if let Some(additional) = &config.preamble {
            // Add to default
            format!("{}\n\n{}", DEFAULT_PREAMBLE, additional)
        } else {
            // Just use default
            DEFAULT_PREAMBLE.to_string()
        };

        let max_turns = config.max_turns.unwrap_or(25) as usize;

        // Check if we have MCP tools
        let provider = if let Some(mcp_url) = config.mcp_url.as_ref() {
            // Create MCP client
            let mcp_client = Arc::new(SandboxMcpClient::new(mcp_url));

            // Build tool server
            let tool_handle = build_tool_server(mcp_client.clone())
                .map_err(|e| format!("Failed to build tool server: {}", e))?;

            let agent = match config.provider.as_str() {
                "anthropic" => {
                    let client = create_anthropic_client(&config.api_key, base_url)
                        .map_err(|e| e.to_string())?;
                    let model = AnthropicModel::with_model(client, &config.model);
                    let agent = rig::agent::AgentBuilder::new(model)
                        .preamble(&preamble)
                        .tool_server_handle(tool_handle)
                        .build();
                    AgentWithTools::Anthropic(agent)
                }
                "gemini" | "google" => {
                    let client = create_gemini_client(&config.api_key, base_url)
                        .map_err(|e| e.to_string())?;
                    let model = GeminiModel::new(client, &config.model);
                    let agent = rig::agent::AgentBuilder::new(model)
                        .preamble(&preamble)
                        .tool_server_handle(tool_handle)
                        .build();
                    AgentWithTools::Gemini(agent)
                }
                _ => {
                    // Default to OpenAI-compatible
                    let client = create_openai_client(&config.api_key, base_url)
                        .map_err(|e| e.to_string())?;
                    let model = OpenAIModel::new(client, &config.model);
                    let agent = rig::agent::AgentBuilder::new(model)
                        .preamble(&preamble)
                        .tool_server_handle(tool_handle)
                        .build();
                    AgentWithTools::OpenAI(agent)
                }
            };

            AgentProvider::WithTools { agent, mcp_client }
        } else {
            // No MCP URL - create simple agent without tools
            let agent = match config.provider.as_str() {
                "anthropic" => {
                    let client = create_anthropic_client(&config.api_key, base_url)
                        .map_err(|e| e.to_string())?;
                    let model = AnthropicModel::with_model(client, &config.model);
                    let agent = rig::agent::AgentBuilder::new(model)
                        .preamble(&preamble)
                        .build();
                    SimpleAgent::Anthropic(agent)
                }
                "gemini" | "google" => {
                    let client = create_gemini_client(&config.api_key, base_url)
                        .map_err(|e| e.to_string())?;
                    let model = GeminiModel::new(client, &config.model);
                    let agent = rig::agent::AgentBuilder::new(model)
                        .preamble(&preamble)
                        .build();
                    SimpleAgent::Gemini(agent)
                }
                _ => {
                    let client = create_openai_client(&config.api_key, base_url)
                        .map_err(|e| e.to_string())?;
                    let model = OpenAIModel::new(client, &config.model);
                    let agent = rig::agent::AgentBuilder::new(model)
                        .preamble(&preamble)
                        .build();
                    SimpleAgent::OpenAI(agent)
                }
            };

            AgentProvider::Simple(agent)
        };

        Ok(Self {
            provider,
            messages: Vec::new(),
            events: std::collections::VecDeque::new(),
            is_streaming: false,
            max_turns,
        })
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

        self.events.push_back(AgentEvent::StreamStart);
        self.is_streaming = true;

        // Convert message history to rig format
        let history: Vec<RigMessage> = self
            .messages
            .iter()
            .take(self.messages.len().saturating_sub(1)) // Exclude current message
            .map(|m| match m.role {
                MessageRole::User => RigMessage::user(&m.content),
                MessageRole::Assistant => RigMessage::assistant(&m.content),
            })
            .collect();

        // Execute the agent - collect events separately to avoid borrow issues
        let (response, tool_events) = match &self.provider {
            AgentProvider::WithTools { agent, .. } => {
                run_agent_with_tools(agent, message, history, self.max_turns)
            }
            AgentProvider::Simple(agent) => {
                let result = run_simple_agent(agent, message);
                (result, Vec::new())
            }
        };

        // Emit collected events
        for event in tool_events {
            self.events.push_back(event);
        }

        match response {
            Ok(text) => {
                self.events.push_back(AgentEvent::StreamChunk(text.clone()));
                self.events
                    .push_back(AgentEvent::StreamComplete(text.clone()));
                self.messages.push(Message {
                    role: MessageRole::Assistant,
                    content: text,
                });
            }
            Err(e) => {
                self.events.push_back(AgentEvent::StreamError(e));
            }
        }

        self.is_streaming = false;
        self.events.push_back(AgentEvent::Ready);

        Ok(())
    }
}

// ============================================================================
// Standalone agent execution functions using shared agent_bridge utilities
// ============================================================================

use agent_bridge::wasm_block_on;

// NOTE: HeadlessEventHandler moved to agent_bridge - this code now uses ActiveStream

fn run_agent_with_tools(
    agent: &AgentWithTools,
    message: &str,
    history: Vec<RigMessage>,
    max_turns: usize,
) -> (Result<String, String>, Vec<AgentEvent>) {
    use agent_bridge::{erase_stream, ActiveStream, PollResult};
    use std::future::IntoFuture;

    // Create the connecting future based on agent type
    let connect_future: agent_bridge::ErasedConnectFuture = match agent {
        AgentWithTools::Anthropic(a) => {
            let future = a
                .stream_chat(message, history)
                .multi_turn(max_turns)
                .into_future();
            Box::pin(async move { erase_stream(future.await) })
        }
        AgentWithTools::OpenAI(a) => {
            let future = a
                .stream_chat(message, history)
                .multi_turn(max_turns)
                .into_future();
            Box::pin(async move { erase_stream(future.await) })
        }
        AgentWithTools::Gemini(a) => {
            let future = a
                .stream_chat(message, history)
                .multi_turn(max_turns)
                .into_future();
            Box::pin(async move { erase_stream(future.await) })
        }
    };

    // Create ActiveStream and poll it to completion
    let mut active_stream = ActiveStream::from_future(connect_future);
    let mut events = Vec::new();

    // Poll loop - this properly handles the multi-turn iterations
    loop {
        // poll_once() is synchronous - it uses noop_waker internally
        let poll_result = active_stream.poll_once();

        match poll_result {
            PollResult::Chunk => {
                // Emit progressive events as we get chunks
                // The buffer accumulates content
            }
            PollResult::Pending => {
                // Yield briefly to allow async work to progress
                std::thread::sleep(std::time::Duration::from_millis(1));
                continue;
            }
            PollResult::Complete => {
                break;
            }
            PollResult::Error(e) => {
                return (Err(e.clone()), events);
            }
        }
    }

    // Get the final content from the buffer
    let buffer = active_stream.buffer();
    let content = buffer.get_content();

    // Check for any tool activity that occurred
    if let Some(activity) = buffer.get_tool_activity() {
        events.push(AgentEvent::ToolCall(activity));
    }

    (Ok(content), events)
}

fn run_simple_agent(agent: &SimpleAgent, message: &str) -> Result<String, String> {
    match agent {
        SimpleAgent::Anthropic(a) => wasm_block_on(a.prompt(message).into_future())
            .map_err(|e| format!("Anthropic error: {}", e)),
        SimpleAgent::OpenAI(a) => wasm_block_on(a.prompt(message).into_future())
            .map_err(|e| format!("OpenAI error: {}", e)),
        SimpleAgent::Gemini(a) => wasm_block_on(a.prompt(message).into_future())
            .map_err(|e| format!("Gemini error: {}", e)),
    }
}

impl HeadlessAgent {
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

// Note: wasm_block_on is now imported from agent_bridge

// ============================================================================
// WIT Interface Implementation
// ============================================================================

struct HeadlessAgentComponent;

impl Guest for HeadlessAgentComponent {
    fn create(config: AgentConfig) -> Result<AgentHandle, String> {
        let agent = HeadlessAgent::new(config)?;
        Ok(with_storage(|s| s.insert(agent)))
    }

    fn destroy(handle: AgentHandle) {
        with_storage(|s| s.remove(handle));
    }

    fn send(handle: AgentHandle, message: String) -> Result<(), String> {
        with_storage(|s| {
            if let Some(agent) = s.get_mut(handle) {
                agent.send(&message)
            } else {
                Err("Invalid agent handle".to_string())
            }
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
        with_storage(|s| {
            s.get_mut(handle)
                .map(|a| a.get_history())
                .unwrap_or_default()
        })
    }

    fn clear_history(handle: AgentHandle) {
        with_storage(|s| {
            if let Some(agent) = s.get_mut(handle) {
                agent.clear_history();
            }
        });
    }
}

bindings::export!(HeadlessAgentComponent with_types_in bindings);
