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
const DEFAULT_PREAMBLE: &str = r##"You are an autonomous coding agent that completes tasks by writing and executing code.

# Conversation Protocol

Your interactions follow a structured protocol using ACTION markers. The user controls which phase you are in.

## [ACTION: PLAN]

When you see this marker, the user is asking you to CREATE A PLAN:
1. Analyze the user's request (included after the marker)
2. Write a detailed implementation plan to `/plan.md` with:
   - Goal summary
   - Step-by-step implementation plan
   - Expected outputs/deliverables
3. Respond with: "Plan written to /plan.md. Awaiting approval to execute."
4. STOP - do NOT write any code or execute anything yet

## [ACTION: EXECUTE]

When you see this marker, the user has APPROVED your plan:
1. Read `/plan.md` to load your implementation plan
2. Execute each step in order, using the sandbox tools
3. After completing ALL steps, report results
4. Confirm with: "✓ Task complete"

# CRITICAL RULES

1. In PLAN phase: ONLY write /plan.md, nothing else
2. In EXECUTE phase: ALWAYS read /plan.md first
3. COMPLETE THE ENTIRE TASK - do NOT stop after one step
4. After each tool call, CONTINUE to the next step immediately

# Sandbox Environment

You are running in a browser-based OPFS (Origin Private File System) sandbox.

## Available Tools

### File Operations
- `write_file(path, content)` - Write content to a file
- `read_file(path)` - Read file contents
- `list(path)` - List directory contents
- `grep(pattern, path)` - Search for patterns in files

### Code Execution
- `run_command(command)` - Execute shell commands

All paths are relative to the OPFS root (e.g., `/plan.md`, `/src/app.ts`).

## Shell Commands (run_command)

The shell supports:
- `tsx script.ts` - Execute TypeScript/JavaScript
- `cat`, `ls`, `mkdir`, `rm`, `cp`, `mv` - File operations
- `echo`, `grep`, `sed` - Text processing

## TypeScript Execution (tsx)

ALWAYS prefer single-file TypeScript. The tsx engine supports:

```typescript
console.log("Hello");      // Built-in console
await fetch(url);          // Built-in fetch
import { z } from 'zod';   // Auto-fetches from esm.sh CDN
```

### Build Pattern

For TypeScript projects, build into a SINGLE FILE:
1. Write all code to a single `.ts` file
2. Run with: `run_command("tsx myfile.ts")`
3. DO NOT create package.json or tsconfig.json unless asked

# Example Workflows

## Planning Phase

User: [ACTION: PLAN]
Build a calculator that adds two numbers

You:
1. Call write_file to create /plan.md with your implementation plan
2. Respond: "Plan written to /plan.md. Awaiting approval to execute."
3. STOP - do not continue

## Execution Phase

User: [ACTION: EXECUTE]

You:
1. Call read_file to load /plan.md
2. Call write_file to create calculator.ts with the implementation
3. Call run_command with "tsx calculator.ts" to run and verify
4. Respond: "Task complete. Calculator written and tested successfully."
"##;

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
    /// Active stream for event-driven polling (like TUI)
    active_stream: Option<agent_bridge::ActiveStream>,
    /// Track last tool activity for event emission
    last_tool_activity: Option<String>,
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
            active_stream: None,
            last_tool_activity: None,
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

        // Create the active stream (but don't block on it)
        let active_stream = match &self.provider {
            AgentProvider::WithTools { agent, .. } => Some(create_active_stream_with_tools(
                agent,
                message,
                history,
                self.max_turns,
            )),
            AgentProvider::Simple(agent) => {
                // For simple agents, we still block since they don't need tool loops
                let result = run_simple_agent(agent, message);
                match result {
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
                None
            }
        };

        self.active_stream = active_stream;
        Ok(())
    }

    /// Planning phase - sends user request with [ACTION: PLAN] marker
    /// Agent should analyze and write /plan.md, then stop and wait for approval
    fn plan(&mut self, user_request: &str) -> Result<(), String> {
        let message = format!("[ACTION: PLAN]\n{}", user_request);
        self.send(&message)
    }

    /// Execution phase - sends [ACTION: EXECUTE] marker
    /// Agent should read /plan.md and execute all steps
    fn execute(&mut self) -> Result<(), String> {
        self.send("[ACTION: EXECUTE]")
    }
}

// ============================================================================
// Standalone agent execution functions using shared agent_bridge utilities
// ============================================================================

use agent_bridge::wasm_block_on;

// NOTE: HeadlessEventHandler moved to agent_bridge - this code now uses ActiveStream

fn create_active_stream_with_tools(
    agent: &AgentWithTools,
    message: &str,
    history: Vec<RigMessage>,
    max_turns: usize,
) -> agent_bridge::ActiveStream {
    use agent_bridge::erase_stream;
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

    // Create and return the ActiveStream (don't poll it here)
    agent_bridge::ActiveStream::from_future(connect_future)
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
        use agent_bridge::PollResult;

        // First, return any queued events
        if let Some(event) = self.events.pop_front() {
            return Some(event);
        }

        // If we have an active stream, poll it
        if let Some(stream) = &mut self.active_stream {
            let result = stream.poll_once();

            // Check for tool activity updates (like TUI does)
            let activity = stream.buffer().get_tool_activity();
            if activity != self.last_tool_activity {
                if let Some(act) = &activity {
                    // Tool call started
                    self.events.push_back(AgentEvent::ToolCall(act.clone()));
                } else if let Some(last) = &self.last_tool_activity {
                    // Tool call finished
                    self.events
                        .push_back(AgentEvent::ToolResult(bindings::ToolResultData {
                            name: last.clone(),
                            output: "Done".to_string(),
                            is_error: false,
                        }));
                }
                self.last_tool_activity = activity;
            }

            match result {
                PollResult::Chunk => {
                    let content = stream.buffer().get_content();
                    self.events.push_back(AgentEvent::StreamChunk(content));
                }
                PollResult::Pending => {
                    // Still pending - JS will call poll() again
                    // Don't block or sleep, just return None
                }
                PollResult::Complete => {
                    let content = stream.buffer().get_content();
                    self.events
                        .push_back(AgentEvent::StreamChunk(content.clone()));
                    self.events
                        .push_back(AgentEvent::StreamComplete(content.clone()));
                    self.messages.push(Message {
                        role: MessageRole::Assistant,
                        content,
                    });
                    self.is_streaming = false;
                    self.active_stream = None;
                    self.events.push_back(AgentEvent::Ready);
                }
                PollResult::Error(e) => {
                    self.events.push_back(AgentEvent::StreamError(e));
                    self.is_streaming = false;
                    self.active_stream = None;
                    self.events.push_back(AgentEvent::Ready);
                }
            }

            // Return any event we just pushed
            return self.events.pop_front();
        }

        None
    }

    fn cancel(&mut self) {
        if self.is_streaming {
            self.is_streaming = false;
            self.active_stream = None;
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

    fn plan(handle: AgentHandle, message: String) -> Result<(), String> {
        with_storage(|s| {
            if let Some(agent) = s.get_mut(handle) {
                agent.plan(&message)
            } else {
                Err("Invalid agent handle".to_string())
            }
        })
    }

    fn execute(handle: AgentHandle) -> Result<(), String> {
        with_storage(|s| {
            if let Some(agent) = s.get_mut(handle) {
                agent.execute()
            } else {
                Err("Invalid agent handle".to_string())
            }
        })
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
