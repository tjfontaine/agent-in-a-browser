//! Main application state and event loop
//!
//! Manages the TUI lifecycle: init, render, input handling, cleanup.

use ratatui::Terminal;

use crate::backend::{enter_alternate_screen, leave_alternate_screen, WasiBackend};
use crate::bridge::{
    get_local_tool_definitions, get_system_message,
    mcp_client::ToolDefinition,
    rig_agent::{RigAgent, StreamingBuffer},
    McpClient,
};

use crate::config::{self, Config};
use crate::input::InputBuffer;
use crate::servers::{ServerManager, ToolCollector};

use crate::ui::{
    render_ui, AuxContent, AuxContentKind, Mode, Overlay, RemoteServerEntry,
    ServerConnectionStatus, ServerManagerView, ServerStatus,
};
use std::io::{Read, Write};

/// App state enumeration
#[derive(Clone, Copy, PartialEq)]
pub enum AppState {
    /// Normal operation - ready for input
    Ready,
    /// Waiting for API key input
    NeedsApiKey,
    /// Processing a request (AI or MCP)
    Processing,
    /// Streaming a response (async streaming in progress)
    Streaming,
}

/// Main application state
pub struct App<R: Read, W: Write> {
    /// Current mode
    pub(crate) mode: Mode,
    /// Current state
    pub(crate) state: AppState,
    /// Input buffer with readline-like editing
    pub(crate) input: InputBuffer,
    /// Chat/output history  
    pub(crate) messages: Vec<Message>,
    /// Command history for up/down navigation
    history: Vec<String>,
    /// Current position in history
    history_index: usize,
    /// Terminal
    terminal: Terminal<WasiBackend<W>>,
    /// Stdin handle
    stdin: R,
    /// Should quit
    should_quit: bool,
    /// Rig-core Agent for multi-turn tool calling
    rig_agent: Option<RigAgent>,
    /// MCP client (local sandbox)
    mcp_client: McpClient,
    /// Pending message to send after API key is set
    pending_message: Option<String>,
    /// Auxiliary panel content
    pub(crate) aux_content: AuxContent,
    /// Server connection status
    pub(crate) server_status: ServerStatus,
    /// Flag to cancel current operation
    cancelled: bool,
    /// Remote MCP server connections
    pub(crate) remote_servers: Vec<RemoteServerEntry>,
    /// Current overlay (modal popup)
    pub(crate) overlay: Option<Overlay>,
    /// Loaded configuration
    config: Config,
    /// Active streaming buffer for async response streaming
    streaming_buffer: Option<StreamingBuffer>,
}

/// A message in the chat history
#[derive(Clone)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Role {
    User,
    Assistant,
    System,
    Tool,
}

impl<R: Read, W: Write> App<R, W> {
    /// Create a new App with std Read/Write streams
    pub fn new(stdin: R, mut stdout: W, width: u16, height: u16) -> Self {
        // Enter alternate screen mode
        let _ = enter_alternate_screen(&mut stdout);

        let backend = WasiBackend::new(stdout, width, height);
        let terminal = Terminal::new(backend).expect("failed to create terminal");

        // Create MCP client pointing to sandbox
        // The URL will be proxied by the frontend to the actual sandbox worker
        let mcp_client = McpClient::new("http://localhost:3000/mcp");

        // Load config from OPFS (or use defaults)
        let config = Config::load();

        // Load agent history once
        let loaded_history = config::load_agent_history();
        let loaded_history_len = loaded_history.len();

        Self {
            mode: Mode::Agent,
            state: AppState::Ready,
            input: InputBuffer::new(),
            messages: vec![Message {
                role: Role::System,
                content: "Welcome to Agent in a Browser! Type /help for commands.".to_string(),
            }],
            history: loaded_history,
            history_index: loaded_history_len,
            terminal,
            stdin,
            should_quit: false,
            rig_agent: None, // Lazily initialized when first used
            mcp_client,
            pending_message: None,
            aux_content: AuxContent::default(),
            server_status: ServerStatus {
                local_connected: false, // Will be set after MCP init
                local_tool_count: 0,
                remote_servers: Vec::new(),
            },
            cancelled: false,
            remote_servers: Vec::new(),
            overlay: None,
            config,
            streaming_buffer: None,
        }
    }

    /// Main run loop
    pub fn run(&mut self) -> i32 {
        // Setup
        self.setup_terminal();

        // Initial render
        self.render();

        // Main loop: input then render
        // (This order ensures resize events are processed before drawing)
        while !self.should_quit {
            // Handle input (including resize events from stdin)
            self.handle_input();

            // Poll streaming buffer if active
            self.poll_streaming_buffer();

            // Render
            self.render();
        }

        // Cleanup
        self.cleanup_terminal();

        0
    }

    fn setup_terminal(&mut self) {
        let _ = self.terminal.clear();
        let _ = self.terminal.hide_cursor();
    }

    fn cleanup_terminal(&mut self) {
        let _ = self.terminal.show_cursor();
        // Leave alternate screen - need to access writer through backend
        let _ = leave_alternate_screen(self.terminal.backend_mut().writer_mut());
    }

    /// Get the current model name for display
    pub fn model_name(&self) -> &str {
        &self.config.current_provider_settings().model
    }

    /// Get the current provider name
    pub fn provider_name(&self) -> &str {
        self.config.current_provider()
    }

    /// Check if API key is set for the current provider
    pub fn has_api_key(&self) -> bool {
        self.config
            .current_provider_settings()
            .api_key
            .as_ref()
            .map_or(false, |k| !k.is_empty())
    }

    /// Get the API key for the current provider
    pub fn get_api_key(&self) -> Option<&str> {
        self.config.current_provider_settings().api_key.as_deref()
    }

    /// Set the API key for the current provider
    pub fn set_api_key(&mut self, key: &str) {
        self.config.current_provider_settings_mut().api_key = Some(key.to_string());
        let _ = self.config.save();
        // Invalidate the agent so it's recreated with the new key
        self.rig_agent = None;
    }

    /// Set the provider (anthropic or openai)
    pub fn set_provider(&mut self, provider: &str) {
        self.config.providers.default = provider.to_string();
        let _ = self.config.save();
        // Invalidate the agent so it's recreated with the new provider
        self.rig_agent = None;
    }

    /// Set the model for the current provider
    pub fn set_model(&mut self, model: &str) {
        self.config.current_provider_settings_mut().model = model.to_string();
        let _ = self.config.save();
        // Invalidate the agent so it's recreated with the new model
        self.rig_agent = None;
    }

    /// Get the base URL for the current provider
    pub fn get_base_url(&self) -> Option<&str> {
        self.config.current_provider_settings().base_url.as_deref()
    }

    /// Set the base URL for the current provider
    pub fn set_base_url(&mut self, url: &str) {
        self.config.current_provider_settings_mut().base_url = Some(url.to_string());
        let _ = self.config.save();
        // Invalidate the agent so it's recreated with the new base URL
        self.rig_agent = None;
    }

    fn render(&mut self) {
        let mode = self.mode;
        let state = self.state;
        let input = self.input.clone();
        let messages = self.messages.clone();
        let aux_content = self.aux_content.clone();
        let server_status = self.server_status.clone();

        let model_name = self.model_name().to_string();
        let overlay = self.overlay.clone();
        let remote_servers = self.remote_servers.clone();

        let _ = self.terminal.draw(|frame| {
            render_ui(
                frame,
                mode,
                state,
                input.text(),
                input.cursor_pos(),
                &messages,
                &aux_content,
                &server_status,
                &model_name,
                overlay.as_ref(),
                &remote_servers,
            );
        });
    }

    fn handle_input(&mut self) {
        // Read all available bytes (for paste support)
        // Keep reading until we'd block or process a special sequence
        loop {
            let mut buf = [0u8; 32]; // Read in larger chunks to catch escape sequences
            match self.stdin.read(&mut buf) {
                Ok(0) => break, // No more data
                Ok(n) => {
                    let bytes = &buf[..n];
                    let should_break = self.process_input_bytes(bytes);
                    if should_break {
                        break;
                    }
                }
                Err(_) => break, // Error or would block
            }
        }
    }

    /// Process a slice of input bytes, returns true if we should stop reading
    fn process_input_bytes(&mut self, bytes: &[u8]) -> bool {
        let mut i = 0;
        while i < bytes.len() {
            let byte = bytes[i];

            // If overlay is active, handle with escape sequence detection
            if self.overlay.is_some() {
                let (key, consumed) = if byte == 0x1B && i + 2 < bytes.len() && bytes[i + 1] == b'['
                {
                    // Escape sequence - check the command byte
                    let key = match bytes[i + 2] {
                        b'A' => 0xF0, // Up arrow
                        b'B' => 0xF1, // Down arrow
                        b'C' => 0xF2, // Right arrow
                        b'D' => 0xF3, // Left arrow
                        _ => 0x1B,    // Unknown, treat as Esc
                    };
                    (key, if key != 0x1B { 3 } else { 1 }) // Consume 3 bytes for arrow, 1 for bare Esc
                } else {
                    (byte, 1)
                };
                self.handle_overlay_input(key);
                i += consumed;
                continue;
            }

            // Normal input handling
            // ALL escape sequence parsing happens from buffer - never read more from stdin mid-loop
            if byte == 0x1B {
                if i + 2 < bytes.len() && bytes[i + 1] == b'[' {
                    let cmd = bytes[i + 2];
                    match cmd {
                        // Arrow keys - 3 byte sequences
                        b'A' | b'B' | b'C' | b'D' => {
                            self.handle_escape_sequence(&[b'[', cmd]);
                            i += 3;
                            continue;
                        }
                        // Resize sequence: ESC [ 8 ; rows ; cols t
                        b'8' => {
                            // Find the terminating 't'
                            let mut end_idx = i + 3;
                            while end_idx < bytes.len() && bytes[end_idx] != b't' {
                                end_idx += 1;
                            }
                            if end_idx < bytes.len() {
                                // Parse resize: 8;rows;cols
                                let params = &bytes[i + 3..end_idx]; // Skip ESC [ 8
                                if let Ok(param_str) = std::str::from_utf8(params) {
                                    let parts: Vec<&str> = param_str.split(';').collect();
                                    if parts.len() == 2 {
                                        if let (Ok(rows), Ok(cols)) =
                                            (parts[0].parse::<u16>(), parts[1].parse::<u16>())
                                        {
                                            self.handle_resize(cols, rows);
                                        }
                                    }
                                }
                                i = end_idx + 1; // Skip past 't'
                                continue;
                            }
                            // Incomplete resize sequence - skip rest of buffer
                            return false;
                        }
                        // Other/unknown sequences - skip the 3 bytes we can see
                        _ => {
                            i += 3;
                            continue;
                        }
                    }
                } else {
                    // Bare/incomplete escape - just skip it
                    i += 1;
                    continue;
                }
            }

            // Regular character - process normally
            let should_break = self.process_single_byte(byte, &bytes[i..]);
            if should_break {
                return true;
            }
            i += 1;
        }
        false
    }

    /// Process a single input byte (non-overlay case)
    fn process_single_byte(&mut self, byte: u8, _remaining: &[u8]) -> bool {
        // Handle control characters via InputBuffer
        if self.input.handle_control(byte) {
            return false;
        }

        match byte {
            // Ctrl+C - cancel during processing, quit otherwise
            0x03 => {
                if self.state == AppState::Processing {
                    self.cancelled = true;
                    false // Continue to allow check in streaming loop
                } else {
                    self.should_quit = true;
                    true
                }
            }
            // Ctrl+D - exit shell mode or quit
            0x04 => {
                if self.mode == Mode::Shell {
                    self.mode = Mode::Agent;
                    self.messages.push(Message {
                        role: Role::System,
                        content: "Exiting shell mode.".to_string(),
                    });
                } else {
                    self.should_quit = true;
                }
                true
            }
            // Ctrl+N - switch to normal (agent) mode
            0x0E => {
                if self.mode != Mode::Agent {
                    self.mode = Mode::Agent;
                    self.messages.push(Message {
                        role: Role::System,
                        content: "Switched to normal mode.".to_string(),
                    });
                }
                true
            }
            // Ctrl+P - toggle plan mode
            0x10 => {
                if self.mode == Mode::Plan {
                    self.mode = Mode::Agent;
                    self.messages.push(Message {
                        role: Role::System,
                        content: "Exiting plan mode.".to_string(),
                    });
                } else if self.mode != Mode::Shell {
                    self.mode = Mode::Plan;
                    self.messages.push(Message {
                        role: Role::System,
                        content: "Entering plan mode. Type 'go' to execute plan, or /mode normal to exit.".to_string(),
                    });
                }
                true
            }
            // Enter - submit
            0x0D | 0x0A => {
                if !self.input.is_empty() {
                    self.submit_input();
                }
                true // Stop reading after enter
            }
            // Tab - autocomplete slash commands
            0x09 => {
                self.try_tab_complete();
                false
            }
            // Printable ASCII - insert at cursor
            0x20..=0x7E => {
                self.input.insert_char(byte as char);
                false // Continue reading (for paste)
            }
            // Escape sequence start - should be handled by process_input_bytes
            // but if we get here, just ignore it
            0x1B => false,
            _ => false,
        }
    }

    fn handle_escape_sequence(&mut self, first_bytes: &[u8]) {
        // Handle bare Escape (seq would be empty or not '[')
        if first_bytes.len() < 2 || first_bytes[0] != b'[' {
            // Bare Escape key - cancel API key entry
            if self.state == AppState::NeedsApiKey {
                self.state = AppState::Ready;
                self.pending_message = None;
                self.input.clear();
                self.messages.push(Message {
                    role: Role::System,
                    content: "API key entry cancelled.".to_string(),
                });
            }
            return;
        }

        let second = first_bytes[1];

        // Note: Resize sequences (ESC [ 8 ; rows ; cols t) are now handled
        // in process_input_bytes before reaching here

        match second {
            // Up arrow - history previous
            b'A' => {
                if self.history_index > 0 {
                    self.history_index -= 1;
                    if let Some(cmd) = self.history.get(self.history_index) {
                        self.input.set_text(cmd.clone());
                    }
                }
            }
            // Down arrow - history next
            b'B' => {
                if self.history_index < self.history.len() {
                    self.history_index += 1;
                    if self.history_index >= self.history.len() {
                        self.input.clear();
                    } else if let Some(cmd) = self.history.get(self.history_index) {
                        self.input.set_text(cmd.clone());
                    }
                }
            }
            // Right arrow - move cursor right
            b'C' => {
                self.input.move_right();
            }
            // Left arrow - move cursor left
            b'D' => {
                self.input.move_left();
            }
            _ => {}
        }
    }

    fn handle_resize(&mut self, cols: u16, rows: u16) {
        // Update the terminal backend size
        self.terminal.backend_mut().set_size(cols, rows);
        // Force a redraw
        let _ = self.terminal.clear();
    }

    fn submit_input(&mut self) {
        let input = self.input.take();

        match self.state {
            AppState::NeedsApiKey => {
                // This input is the API key - don't add to history
                // set_api_key saves to config and invalidates agent
                self.set_api_key(&input);

                self.messages.push(Message {
                    role: Role::System,
                    content: "API key set and saved.".to_string(),
                });
                self.state = AppState::Ready;

                // If we have a pending message, send it now
                if let Some(pending) = self.pending_message.take() {
                    self.send_to_ai(&pending);
                }
            }
            AppState::Streaming => {
                // Input is ignored during streaming
                // User can only cancel with Ctrl+C
            }
            AppState::Ready | AppState::Processing => {
                // Add to command history and save
                config::add_to_history(&mut self.history, input.clone());
                config::save_agent_history(&self.history);
                // Reset history navigation to end
                self.history_index = self.history.len();

                // Handle based on mode
                match self.mode {
                    Mode::Shell => {
                        // Shell mode: execute command via MCP
                        self.execute_shell_command(&input);
                    }
                    Mode::Agent | Mode::Plan => {
                        // Add user message
                        self.messages.push(Message {
                            role: Role::User,
                            content: input.clone(),
                        });

                        // Handle slash commands
                        if input.starts_with('/') {
                            self.handle_slash_command(&input);
                        } else {
                            // Regular message - send to AI
                            self.send_to_ai(&input);
                        }
                    }
                }
            }
        }
    }

    /// Execute a shell command via MCP shell_eval
    fn execute_shell_command(&mut self, command: &str) {
        // Show the command with shell prompt
        self.messages.push(Message {
            role: Role::User,
            content: format!("$ {}", command),
        });

        // Handle shell-local commands
        if command.trim() == "exit" {
            self.mode = Mode::Agent;
            self.messages.push(Message {
                role: Role::System,
                content: "Exiting shell mode.".to_string(),
            });
            return;
        }

        if command.trim() == "clear" {
            self.messages.clear();
            self.messages.push(Message {
                role: Role::System,
                content: "Shell mode - type 'exit' or ^D to return".to_string(),
            });
            return;
        }

        self.state = AppState::Processing;

        // Call shell_eval via MCP
        let args = serde_json::json!({
            "command": command
        });

        match self.mcp_client.call_tool("shell_eval", args) {
            Ok(output) => {
                // Update aux panel with full output
                self.aux_content = AuxContent {
                    kind: AuxContentKind::ToolOutput,
                    title: "Shell Output".to_string(),
                    content: output.clone(),
                };

                // Show output in messages (truncate if long)
                let display = if output.len() > 500 {
                    format!("{}...\n[see aux panel →]", &output[..500])
                } else {
                    output
                };

                self.messages.push(Message {
                    role: Role::Tool,
                    content: display,
                });
            }
            Err(e) => {
                self.messages.push(Message {
                    role: Role::System,
                    content: format!("Error: {}", e),
                });
            }
        }

        self.state = AppState::Ready;
    }

    fn send_to_ai(&mut self, message: &str) {
        // Check if API key is set
        let api_key = match self.get_api_key() {
            Some(key) if !key.is_empty() => key.to_string(),
            _ => {
                // Store the message and prompt for API key
                self.pending_message = Some(message.to_string());
                self.state = AppState::NeedsApiKey;
                self.messages.push(Message {
                    role: Role::System,
                    content: "Please enter your API key:".to_string(),
                });
                return;
            }
        };

        self.state = AppState::Processing;
        self.cancelled = false; // Reset cancellation flag

        // Ensure RigAgent is initialized
        if self.rig_agent.is_none() {
            let preamble = get_system_message(&self.collect_all_tools()).content;
            let model = self.model_name().to_string();
            let provider = self.provider_name().to_string();
            let api_format = self.config.current_api_format().to_string();
            let base_url = self.get_base_url().map(|s| s.to_string());

            let agent_result = RigAgent::from_config(
                &api_key,
                &model,
                &api_format,
                base_url.as_deref(),
                &preamble,
                self.mcp_client.clone(),
            );

            match agent_result {
                Ok(agent) => {
                    self.rig_agent = Some(agent);
                    let provider_info = if let Some(url) = &base_url {
                        format!("{} @ {}", provider, url)
                    } else {
                        provider.clone()
                    };
                    self.messages.push(Message {
                        role: Role::System,
                        content: format!("🤖 Agent initialized ({} / {})", provider_info, model),
                    });
                }
                Err(e) => {
                    self.messages.push(Message {
                        role: Role::System,
                        content: format!("Failed to initialize agent: {}", e),
                    });
                    self.state = AppState::Ready;
                    return;
                }
            }
        }

        // Get reference to agent
        let agent = self.rig_agent.as_ref().unwrap();

        // Use streaming with for_each_blocking for WASIP2 compatibility
        // This uses JSPI suspension during blocking_read instead of block_on which deadlocks

        // Create streaming buffer
        let buffer = StreamingBuffer::new();
        self.streaming_buffer = Some(buffer.clone());

        // Add placeholder assistant message
        self.messages.push(Message {
            role: Role::Assistant,
            content: "".to_string(),
        });

        // Start streaming - this will block until complete but JSPI handles suspension
        agent.stream_prompt_with_buffer(&message, buffer.clone());

        // Streaming completed - update final message
        let final_content = buffer.get_content();

        if let Some(last_msg) = self.messages.last_mut() {
            if last_msg.role == Role::Assistant {
                last_msg.content = final_content;
            }
        }

        self.streaming_buffer = None;
        self.state = AppState::Ready;
    }

    /// Poll the streaming buffer and update the assistant message
    fn poll_streaming_buffer(&mut self) {
        // Only poll if we're in streaming state
        if self.state != AppState::Streaming {
            return;
        }

        let buffer = match &self.streaming_buffer {
            Some(buf) => buf.clone(),
            None => {
                // No buffer, transition back to ready
                self.state = AppState::Ready;
                return;
            }
        };

        // Get latest content from buffer
        let content = buffer.get_content();
        let tool_activity = buffer.get_tool_activity();

        // Update the last assistant message (it should be the most recent)
        if let Some(last_msg) = self.messages.last_mut() {
            if last_msg.role == Role::Assistant {
                // Show content plus any current tool activity
                if let Some(activity) = tool_activity {
                    last_msg.content = format!("{}\n\n{}", content, activity);
                } else {
                    last_msg.content = content;
                }
            }
        }

        // Check if streaming is complete
        if buffer.is_complete() {
            // Check for errors
            if let Some(error) = buffer.get_error() {
                self.messages.push(Message {
                    role: Role::System,
                    content: format!("Streaming error: {}", error),
                });
            }

            // Clean up and return to ready state
            self.streaming_buffer = None;
            self.state = AppState::Ready;
        }

        // Check if cancelled
        if buffer.is_cancelled() {
            self.messages.push(Message {
                role: Role::System,
                content: "Streaming cancelled.".to_string(),
            });
            self.streaming_buffer = None;
            self.state = AppState::Ready;
        }
    }

    /// Handle input when an overlay is active
    fn handle_overlay_input(&mut self, byte: u8) {
        let overlay = match &mut self.overlay {
            Some(overlay) => overlay,
            None => return,
        };

        match overlay {
            Overlay::ServerManager(view) => {
                match view {
                    ServerManagerView::ServerList { selected } => {
                        let max_items = 2 + self.remote_servers.len(); // Local + Add New + remotes
                        match byte {
                            0x1B => {
                                // Esc - close overlay
                                self.overlay = None;
                            }
                            0xF0 | 0x6B => {
                                // Up arrow (decoded) or 'k'
                                if *selected > 0 {
                                    *selected -= 1;
                                }
                            }
                            0xF1 | 0x6A => {
                                // Down arrow (decoded) or 'j'
                                if *selected + 1 < max_items {
                                    *selected += 1;
                                }
                            }
                            0x0D => {
                                // Enter - select item
                                if *selected == 0 {
                                    // Local server - show info then back to list
                                    self.overlay = Some(Overlay::ServerManager(
                                        ServerManagerView::ServerActions {
                                            server_id: "__local__".to_string(),
                                            selected: 0,
                                        },
                                    ));
                                } else if *selected == 1 {
                                    // Add new server
                                    self.overlay = Some(Overlay::ServerManager(
                                        ServerManagerView::AddServer {
                                            url_input: String::new(),
                                            error: None,
                                        },
                                    ));
                                } else {
                                    // Remote server - show actions
                                    let idx = *selected - 2;
                                    if let Some(server) = self.remote_servers.get(idx) {
                                        self.overlay = Some(Overlay::ServerManager(
                                            ServerManagerView::ServerActions {
                                                server_id: server.id.clone(),
                                                selected: 0,
                                            },
                                        ));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    ServerManagerView::ServerActions {
                        server_id,
                        selected,
                    } => {
                        let is_local = server_id == "__local__";
                        let action_count = if is_local { 1 } else { 4 }; // Back only for local, others have 4 actions
                        match byte {
                            0x1B => {
                                // Esc - back to list
                                self.overlay =
                                    Some(Overlay::ServerManager(ServerManagerView::ServerList {
                                        selected: 0,
                                    }));
                            }
                            0xF0 | 0x6B => {
                                // Up arrow (decoded) or 'k'
                                if *selected > 0 {
                                    *selected -= 1;
                                }
                            }
                            0xF1 | 0x6A => {
                                // Down arrow (decoded) or 'j'
                                if *selected + 1 < action_count {
                                    *selected += 1;
                                }
                            }
                            0x0D => {
                                // Enter - execute action
                                if is_local {
                                    // Just go back
                                    self.overlay = Some(Overlay::ServerManager(
                                        ServerManagerView::ServerList { selected: 0 },
                                    ));
                                } else {
                                    let sid = server_id.clone();
                                    match *selected {
                                        0 => {
                                            // Connect/Disconnect
                                            self.toggle_server_connection(&sid);
                                        }
                                        1 => {
                                            // Set API Key
                                            self.overlay = Some(Overlay::ServerManager(
                                                ServerManagerView::SetToken {
                                                    server_id: sid,
                                                    token_input: String::new(),
                                                    error: None,
                                                },
                                            ));
                                        }
                                        2 => {
                                            // Remove
                                            self.remove_remote_server(&sid);
                                            self.overlay = Some(Overlay::ServerManager(
                                                ServerManagerView::ServerList { selected: 0 },
                                            ));
                                        }
                                        3 => {
                                            // Back
                                            self.overlay = Some(Overlay::ServerManager(
                                                ServerManagerView::ServerList { selected: 0 },
                                            ));
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    ServerManagerView::AddServer {
                        url_input,
                        error: _error,
                    } => {
                        match byte {
                            0x1B => {
                                // Esc - cancel, back to list
                                self.overlay =
                                    Some(Overlay::ServerManager(ServerManagerView::ServerList {
                                        selected: 0,
                                    }));
                            }
                            0x0D => {
                                // Enter - add server
                                let url = url_input.clone();
                                if !url.is_empty() {
                                    self.add_remote_server(&url);
                                    self.overlay = Some(Overlay::ServerManager(
                                        ServerManagerView::ServerList { selected: 0 },
                                    ));
                                }
                            }
                            0x7F | 0x08 => {
                                // Backspace
                                url_input.pop();
                            }
                            0x20..=0x7E => {
                                // Printable character
                                url_input.push(byte as char);
                            }
                            _ => {}
                        }
                    }
                    ServerManagerView::SetToken {
                        server_id,
                        token_input,
                        error: _error,
                    } => {
                        match byte {
                            0x1B => {
                                // Esc - cancel
                                self.overlay = Some(Overlay::ServerManager(
                                    ServerManagerView::ServerActions {
                                        server_id: server_id.clone(),
                                        selected: 0,
                                    },
                                ));
                            }
                            0x0D => {
                                // Enter - set token
                                let sid = server_id.clone();
                                let token = token_input.clone();
                                if !token.is_empty() {
                                    self.set_server_token(&sid, &token);
                                    self.overlay = Some(Overlay::ServerManager(
                                        ServerManagerView::ServerList { selected: 0 },
                                    ));
                                }
                            }
                            0x7F | 0x08 => {
                                // Backspace
                                token_input.pop();
                            }
                            0x20..=0x7E => {
                                // Printable character
                                token_input.push(byte as char);
                            }
                            _ => {}
                        }
                    }
                }
            }
            Overlay::ModelSelector {
                selected,
                provider,
                fetched_models,
            } => {
                // Calculate item count: 1 (refresh) + models
                let model_count = if let Some(models) = fetched_models.as_ref() {
                    if models.is_empty() {
                        1
                    } else {
                        models.len()
                    }
                } else {
                    crate::ui::server_manager::get_models_for_provider(provider).len()
                };
                let max_items = 1 + model_count; // +1 for refresh option

                match byte {
                    0x1B => {
                        // Esc - close overlay
                        self.overlay = None;
                    }
                    0xF0 | 0x6B => {
                        // Up arrow or 'k'
                        if *selected > 0 {
                            *selected -= 1;
                        }
                    }
                    0xF1 | 0x6A => {
                        // Down arrow or 'j'
                        if *selected + 1 < max_items {
                            *selected += 1;
                        }
                    }
                    0x0D => {
                        // Enter - handle selection
                        if *selected == 0 {
                            // Refresh from API - show message about static list
                            self.messages.push(Message {
                                role: Role::System,
                                content: "Using static model list. Select a model below."
                                    .to_string(),
                            });
                        } else {
                            // Select a model (index - 1 because of refresh option)
                            let model_idx = *selected - 1;
                            let static_models =
                                crate::ui::server_manager::get_models_for_provider(provider);

                            if let Some((id, name)) = static_models.get(model_idx) {
                                // Update the model
                                self.set_model(id);
                                self.messages.push(Message {
                                    role: Role::System,
                                    content: format!("Model changed to: {} ({})", name, id),
                                });
                                self.overlay = None;
                            }
                        }
                    }
                    _ => {}
                }
            }

            Overlay::ProviderSelector { selected } => {
                use crate::ui::server_manager::{ProviderWizardStep, PROVIDERS};
                let max_items = PROVIDERS.len();

                match byte {
                    0x1B => {
                        // Esc - close overlay
                        self.overlay = None;
                    }
                    0xF0 | 0x6B => {
                        // Up arrow or 'k'
                        if *selected > 0 {
                            *selected -= 1;
                        }
                    }
                    0xF1 | 0x6A => {
                        // Down arrow or 'j'
                        if *selected + 1 < max_items {
                            *selected += 1;
                        }
                    }
                    0x0D => {
                        // Enter - select provider and open wizard for configuration
                        if let Some((provider_id, _name, base_url)) = PROVIDERS.get(*selected) {
                            // All providers go to wizard for configuration
                            // Pre-fill base URL for preconfigured providers (can be overridden)
                            let prefilled_url = base_url.unwrap_or("").to_string();
                            let prefilled_model =
                                self.config.providers.get(provider_id).model.clone();

                            // Determine start step based on provider type
                            // Custom goes to API format selection first
                            let start_step = if *provider_id == "custom" {
                                ProviderWizardStep::SelectApiFormat
                            } else {
                                ProviderWizardStep::EnterBaseUrl
                            };

                            // Pre-select API format based on provider
                            let api_format = if *provider_id == "anthropic" { 1 } else { 0 };

                            self.overlay = Some(Overlay::ProviderWizard {
                                step: start_step,
                                selected_provider: *selected,
                                selected_api_format: api_format,
                                selected_model: 0,
                                base_url_input: prefilled_url,
                                model_input: prefilled_model,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Overlay::ProviderWizard {
                step,
                selected_provider,
                selected_api_format,
                selected_model,
                base_url_input,
                model_input,
            } => {
                use crate::ui::server_manager::{
                    get_models_for_provider, ProviderWizardStep, API_FORMATS, PROVIDERS,
                };

                match step {
                    ProviderWizardStep::SelectProvider => {
                        // Handle selection like ProviderSelector
                        let max_items = PROVIDERS.len();
                        match byte {
                            0x1B => self.overlay = None,
                            0xF0 | 0x6B => {
                                if *selected_provider > 0 {
                                    *selected_provider -= 1;
                                }
                            }
                            0xF1 | 0x6A => {
                                if *selected_provider + 1 < max_items {
                                    *selected_provider += 1;
                                }
                            }
                            0x0D => {
                                if let Some((provider_id, _, base_url)) =
                                    PROVIDERS.get(*selected_provider)
                                {
                                    if *provider_id == "custom" || base_url.is_none() {
                                        *step = ProviderWizardStep::EnterBaseUrl;
                                    } else {
                                        // Pre-fill base URL and go to model step
                                        *base_url_input = base_url.unwrap_or("").to_string();
                                        *step = ProviderWizardStep::EnterModel;
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    ProviderWizardStep::SelectApiFormat => {
                        // Handle API format selection for custom providers
                        let max_items = API_FORMATS.len();
                        match byte {
                            0x1B => self.overlay = None,
                            0xF0 | 0x6B => {
                                if *selected_api_format > 0 {
                                    *selected_api_format -= 1;
                                }
                            }
                            0xF1 | 0x6A => {
                                if *selected_api_format + 1 < max_items {
                                    *selected_api_format += 1;
                                }
                            }
                            0x0D => {
                                // Proceeding to URL step - pre-fill with format defaults
                                if let Some((_, _, default_url, default_model)) =
                                    API_FORMATS.get(*selected_api_format)
                                {
                                    // Only pre-fill if currently empty
                                    if base_url_input.is_empty() {
                                        *base_url_input = default_url.to_string();
                                    }
                                    if model_input.is_empty() {
                                        *model_input = default_model.to_string();
                                    }
                                }
                                *step = ProviderWizardStep::EnterBaseUrl;
                            }
                            _ => {}
                        }
                    }
                    ProviderWizardStep::EnterBaseUrl => {
                        match byte {
                            0x1B => self.overlay = None,
                            0x0D => {
                                // Enter - proceed to model step if URL is valid
                                if base_url_input.starts_with("http://")
                                    || base_url_input.starts_with("https://")
                                {
                                    *step = ProviderWizardStep::EnterModel;
                                }
                            }
                            0x7F | 0x08 => {
                                // Backspace
                                base_url_input.pop();
                            }
                            b if b >= 0x20 && b < 0x7F => {
                                // Printable ASCII
                                base_url_input.push(b as char);
                            }
                            _ => {}
                        }
                    }
                    ProviderWizardStep::EnterModel => {
                        // Get API format to determine available models
                        let (api_format_id, _, _, _) = API_FORMATS
                            .get(*selected_api_format)
                            .unwrap_or(&("openai", "OpenAI", "", ""));
                        let models = get_models_for_provider(api_format_id);
                        let max_items = models.len() + 1; // +1 for custom input option
                        let is_custom_selected = *selected_model == models.len();

                        match byte {
                            0x1B => self.overlay = None,
                            0xF0 | 0x6B => {
                                // Up arrow
                                if *selected_model > 0 {
                                    *selected_model -= 1;
                                }
                            }
                            0xF1 | 0x6A => {
                                // Down arrow
                                if *selected_model + 1 < max_items {
                                    *selected_model += 1;
                                }
                            }
                            0x0D => {
                                // Enter - select model or proceed with custom
                                if is_custom_selected {
                                    // Custom input - only proceed if model_input is not empty
                                    if !model_input.is_empty() {
                                        *step = ProviderWizardStep::Confirm;
                                    }
                                } else if let Some((model_id, _)) = models.get(*selected_model) {
                                    // Select from list
                                    *model_input = model_id.to_string();
                                    *step = ProviderWizardStep::Confirm;
                                }
                            }
                            0x7F | 0x08 => {
                                // Backspace - only when custom is selected
                                if is_custom_selected {
                                    model_input.pop();
                                }
                            }
                            b if b >= 0x20 && b < 0x7F => {
                                // Printable ASCII - only when custom is selected
                                if is_custom_selected {
                                    model_input.push(b as char);
                                }
                            }
                            _ => {}
                        }
                    }
                    ProviderWizardStep::Confirm => {
                        match byte {
                            0x1B => self.overlay = None,
                            0x0D => {
                                // Enter - apply configuration
                                // Clone values to avoid borrow issues
                                let (provider_id, _, _) = PROVIDERS
                                    .get(*selected_provider)
                                    .unwrap_or(&("custom", "Custom", None));
                                let provider_id = provider_id.to_string();
                                let model = model_input.clone();
                                let base_url = base_url_input.clone();

                                // Close overlay first
                                self.overlay = None;

                                // Update provider and model in config
                                self.set_provider(&provider_id);

                                // Set the model if provided
                                if !model.is_empty() {
                                    self.set_model(&model);
                                }

                                // Store base URL if provided
                                if !base_url.is_empty() {
                                    self.set_base_url(&base_url);
                                }

                                self.messages.push(Message {
                                    role: Role::System,
                                    content: format!(
                                        "Provider switched to {} with model {}",
                                        provider_id,
                                        self.model_name()
                                    ),
                                });
                            }

                            _ => {}
                        }
                    }
                }
            }
        }
    }

    // === Server Management Methods ===

    fn add_remote_server(&mut self, url: &str) {
        ServerManager::add_server(&mut self.remote_servers, url);
    }

    fn remove_remote_server(&mut self, id: &str) {
        ServerManager::remove_server(&mut self.remote_servers, id);
    }

    fn set_server_token(&mut self, id: &str, token: &str) {
        ServerManager::set_token(&mut self.remote_servers, id, token);
    }

    fn toggle_server_connection(&mut self, id: &str) {
        ServerManager::toggle_connection(&mut self.remote_servers, id);
    }

    /// Collect all tools with server prefixes for multi-server routing
    fn collect_all_tools(&mut self) -> Vec<ToolDefinition> {
        // Use closure to access mcp_client
        let (tools, local_connected, local_tool_count) =
            ToolCollector::collect_all_tools(&self.remote_servers, || {
                self.mcp_client.list_tools().map_err(|e| e.to_string())
            });

        self.server_status.local_connected = local_connected;
        self.server_status.local_tool_count = local_tool_count;

        if !local_connected {
            self.messages.push(Message {
                role: Role::System,
                content: "MCP connection error".to_string(),
            });
        }

        tools
    }

    /// Slash commands for tab completion
    const SLASH_COMMANDS: &'static [&'static str] = &[
        "/help",
        "/tools",
        "/mcp",
        "/model",
        "/provider",
        "/theme",
        "/shell",
        "/plan",
        "/mode",
        "/config",
        "/key",
        "/clear",
        "/quit",
    ];

    /// Try to complete the current input with Tab
    fn try_tab_complete(&mut self) {
        // Only complete slash commands for now
        if !self.input.text().starts_with('/') {
            return;
        }

        let prefix = self.input.text();

        // Find matching commands
        let matches: Vec<&str> = Self::SLASH_COMMANDS
            .iter()
            .filter(|cmd| cmd.starts_with(prefix) && **cmd != prefix)
            .copied()
            .collect();

        match matches.len() {
            0 => {
                // No matches - do nothing
            }
            1 => {
                // Single match - complete it
                self.input.set_text(matches[0].to_string());
            }
            _ => {
                // Multiple matches - show them
                let options = matches.join("  ");
                self.messages.push(Message {
                    role: Role::System,
                    content: format!("Completions: {}", options),
                });
            }
        }
    }

    fn handle_slash_command(&mut self, cmd: &str) {
        let parts: Vec<&str> = cmd.trim().split_whitespace().collect();
        let command = parts.first().map(|s| *s).unwrap_or("");

        match command {
            "/help" | "/h" => {
                self.messages.push(Message {
                    role: Role::System,
                    content: [
                        "Commands:",
                        "  /help     - Show this help",
                        "  /tools    - List available tools",
                        "  /mcp      - MCP server manager (j/k=nav, Enter=select)",
                        "  /model    - Select AI model",
                        "  /provider - Select AI provider (Anthropic/OpenAI)",
                        "  /theme    - Change theme (dark, light, gruvbox, catppuccin)",
                        "  /shell    - Enter shell mode (^D to exit)",
                        "  /plan     - Enter plan mode (Ctrl+P to toggle)",
                        "  /mode     - View/change mode (normal, plan, shell)",
                        "  /config   - View current configuration",
                        "  /key      - Set API key",
                        "  /clear    - Clear messages",
                        "  /quit     - Exit (or ^C)",
                    ]
                    .join("\n"),
                });
            }
            "/tools" => {
                // List all available tools
                let mut tool_list = vec!["Available tools:".to_string()];

                // Local tools
                let local_tools = get_local_tool_definitions();
                if !local_tools.is_empty() {
                    tool_list.push("  [local]".to_string());
                    for tool in &local_tools {
                        tool_list.push(format!("    • {}", tool.name));
                    }
                }

                // MCP tools
                match self.mcp_client.list_tools() {
                    Ok(mcp_tools) => {
                        self.server_status.local_connected = true;
                        self.server_status.local_tool_count = mcp_tools.len();
                        if !mcp_tools.is_empty() {
                            tool_list.push("  [sandbox]".to_string());
                            for tool in mcp_tools {
                                tool_list.push(format!("    • {}", tool.name));
                            }
                        }
                    }
                    Err(_) => {
                        self.server_status.local_connected = false;
                        tool_list.push("  [sandbox] not connected".to_string());
                    }
                }

                self.messages.push(Message {
                    role: Role::System,
                    content: tool_list.join("\n"),
                });
            }
            "/servers" | "/mcp" => {
                // Handle MCP subcommands or open overlay
                if let Some(subcmd) = parts.get(1) {
                    match *subcmd {
                        "list" => {
                            // List all servers
                            let mut server_list = vec!["MCP Servers:".to_string()];
                            server_list.push(format!(
                                "  Local sandbox: {}",
                                if self.server_status.local_connected {
                                    "● connected"
                                } else {
                                    "○ disconnected"
                                }
                            ));
                            server_list.push(format!(
                                "    Tools: {}",
                                self.server_status.local_tool_count
                            ));

                            for (i, server) in self.remote_servers.iter().enumerate() {
                                let status = match server.status {
                                    ServerConnectionStatus::Connected => "● connected",
                                    ServerConnectionStatus::Connecting => "◐ connecting",
                                    ServerConnectionStatus::Disconnected => "○ disconnected",
                                    ServerConnectionStatus::AuthRequired => "🔐 auth required",
                                    ServerConnectionStatus::Error(_) => "✗ error",
                                };
                                server_list.push(format!(
                                    "  [{}] {}: {}",
                                    i + 1,
                                    server.name,
                                    status
                                ));
                                server_list.push(format!("      URL: {}", server.url));
                            }
                            self.messages.push(Message {
                                role: Role::System,
                                content: server_list.join("\n"),
                            });
                        }
                        "add" => {
                            // Add new server: /mcp add <url> [name]
                            if let Some(url) = parts.get(2) {
                                let name =
                                    parts.get(3).map(|s| s.to_string()).unwrap_or_else(|| {
                                        // Extract name from URL
                                        url.replace("http://", "")
                                            .replace("https://", "")
                                            .split('/')
                                            .next()
                                            .unwrap_or("Remote")
                                            .to_string()
                                    });
                                // Generate a unique ID for the server
                                let id = format!("remote-{}", self.remote_servers.len() + 1);
                                self.remote_servers.push(RemoteServerEntry {
                                    id,
                                    name: name.clone(),
                                    url: url.to_string(),
                                    status: ServerConnectionStatus::Disconnected,
                                    tools: vec![],
                                    bearer_token: None,
                                });
                                self.messages.push(Message {
                                    role: Role::System,
                                    content: format!(
                                        "Added MCP server '{}'. Use /mcp connect {} to connect.",
                                        name,
                                        self.remote_servers.len()
                                    ),
                                });
                            } else {
                                self.messages.push(Message {
                                    role: Role::System,
                                    content: "Usage: /mcp add <url> [name]".to_string(),
                                });
                            }
                        }
                        "remove" => {
                            // Remove server by index: /mcp remove <id>
                            if let Some(id_str) = parts.get(2) {
                                if let Ok(id) = id_str.parse::<usize>() {
                                    if id > 0 && id <= self.remote_servers.len() {
                                        let removed = self.remote_servers.remove(id - 1);
                                        self.messages.push(Message {
                                            role: Role::System,
                                            content: format!(
                                                "Removed MCP server '{}'.",
                                                removed.name
                                            ),
                                        });
                                    } else {
                                        self.messages.push(Message {
                                            role: Role::System,
                                            content: format!(
                                                "Invalid server ID. Use /mcp list to see IDs."
                                            ),
                                        });
                                    }
                                } else {
                                    self.messages.push(Message {
                                        role: Role::System,
                                        content: "Usage: /mcp remove <id>".to_string(),
                                    });
                                }
                            } else {
                                self.messages.push(Message {
                                    role: Role::System,
                                    content: "Usage: /mcp remove <id>".to_string(),
                                });
                            }
                        }
                        "connect" => {
                            // Connect to server by index: /mcp connect <id>
                            if let Some(id_str) = parts.get(2) {
                                if let Ok(id) = id_str.parse::<usize>() {
                                    if id > 0 && id <= self.remote_servers.len() {
                                        // Mark as connecting and trigger connection
                                        self.remote_servers[id - 1].status =
                                            ServerConnectionStatus::Connecting;
                                        self.messages.push(Message {
                                            role: Role::System,
                                            content: format!(
                                                "Connecting to '{}'...",
                                                self.remote_servers[id - 1].name
                                            ),
                                        });
                                        // TODO: Actually connect to the server
                                    } else {
                                        self.messages.push(Message {
                                            role: Role::System,
                                            content: "Invalid server ID. Use /mcp list to see IDs."
                                                .to_string(),
                                        });
                                    }
                                } else {
                                    self.messages.push(Message {
                                        role: Role::System,
                                        content: "Usage: /mcp connect <id>".to_string(),
                                    });
                                }
                            } else {
                                self.messages.push(Message {
                                    role: Role::System,
                                    content: "Usage: /mcp connect <id>".to_string(),
                                });
                            }
                        }
                        "disconnect" => {
                            // Disconnect from server by index: /mcp disconnect <id>
                            if let Some(id_str) = parts.get(2) {
                                if let Ok(id) = id_str.parse::<usize>() {
                                    if id > 0 && id <= self.remote_servers.len() {
                                        self.remote_servers[id - 1].status =
                                            ServerConnectionStatus::Disconnected;
                                        self.remote_servers[id - 1].tools.clear();
                                        self.messages.push(Message {
                                            role: Role::System,
                                            content: format!(
                                                "Disconnected from '{}'.",
                                                self.remote_servers[id - 1].name
                                            ),
                                        });
                                    } else {
                                        self.messages.push(Message {
                                            role: Role::System,
                                            content: "Invalid server ID. Use /mcp list to see IDs."
                                                .to_string(),
                                        });
                                    }
                                } else {
                                    self.messages.push(Message {
                                        role: Role::System,
                                        content: "Usage: /mcp disconnect <id>".to_string(),
                                    });
                                }
                            } else {
                                self.messages.push(Message {
                                    role: Role::System,
                                    content: "Usage: /mcp disconnect <id>".to_string(),
                                });
                            }
                        }
                        _ => {
                            self.messages.push(Message {
                                role: Role::System,
                                content: format!(
                                    "Unknown subcommand: {}. Available: list, add, remove, connect, disconnect", 
                                    subcmd
                                ),
                            });
                        }
                    }
                } else {
                    // No subcommand - open server manager wizard overlay
                    self.overlay = Some(Overlay::ServerManager(ServerManagerView::ServerList {
                        selected: 0,
                    }));
                }
            }
            "/model" => {
                // Open model selector overlay
                self.overlay = Some(Overlay::ModelSelector {
                    selected: 0,
                    provider: self.config.current_provider().to_string(),
                    fetched_models: None,
                });
            }
            "/provider" => {
                // Handle provider subcommands
                if let Some(subcmd) = parts.get(1) {
                    match *subcmd {
                        "status" => {
                            // Show current provider configuration
                            let base_url = self.get_base_url().unwrap_or("(default)");

                            self.messages.push(Message {
                                role: Role::System,
                                content: format!(
                                    "Provider: {}\nModel: {}\nBase URL: {}\nAPI Key: {}",
                                    self.provider_name(),
                                    self.model_name(),
                                    base_url,
                                    if self.has_api_key() {
                                        "✓ set"
                                    } else {
                                        "✗ not set"
                                    }
                                ),
                            });
                        }
                        "anthropic" => {
                            // Quick switch to Anthropic
                            self.set_provider("anthropic");
                            self.messages.push(Message {
                                role: Role::System,
                                content: format!("Switched to Anthropic ({})", self.model_name()),
                            });
                        }
                        "openai" => {
                            // Quick switch to OpenAI
                            self.set_provider("openai");
                            self.messages.push(Message {
                                role: Role::System,
                                content: format!("Switched to OpenAI ({})", self.model_name()),
                            });
                        }
                        _ => {
                            self.messages.push(Message {
                                role: Role::System,
                                content: format!(
                                    "Unknown subcommand: {}. Available: status, anthropic, openai\nOr use /provider with no args for the wizard.",
                                    subcmd
                                ),
                            });
                        }
                    }
                } else {
                    // No subcommand - open provider selector overlay
                    self.overlay = Some(Overlay::ProviderSelector { selected: 0 });
                }
            }

            "/plan" => {
                // Enter plan mode
                if self.mode == Mode::Plan {
                    self.messages.push(Message {
                        role: Role::System,
                        content:
                            "Already in plan mode. Type 'go' to execute or /mode normal to exit."
                                .to_string(),
                    });
                } else if self.mode == Mode::Shell {
                    self.messages.push(Message {
                        role: Role::System,
                        content: "Exit shell mode first (^D or 'exit').".to_string(),
                    });
                } else {
                    self.mode = Mode::Plan;
                    self.messages.push(Message {
                        role: Role::System,
                        content: "📋 PLAN MODE - Describe what you want to accomplish.\nType 'go' to execute plan, Ctrl+P to toggle, or /mode normal to exit.".to_string(),
                    });
                }
            }
            "/mode" => {
                // View or change mode
                if let Some(mode_arg) = parts.get(1) {
                    match *mode_arg {
                        "normal" | "agent" => {
                            self.mode = Mode::Agent;
                            self.messages.push(Message {
                                role: Role::System,
                                content: "Switched to normal mode.".to_string(),
                            });
                        }
                        "plan" => {
                            self.mode = Mode::Plan;
                            self.messages.push(Message {
                                role: Role::System,
                                content: "📋 Switched to plan mode. Type 'go' to execute or /mode normal to exit.".to_string(),
                            });
                        }
                        "shell" => {
                            self.messages.push(Message {
                                role: Role::System,
                                content: "Use /shell to enter shell mode.".to_string(),
                            });
                        }
                        _ => {
                            self.messages.push(Message {
                                role: Role::System,
                                content: format!(
                                    "Unknown mode: {}. Available: normal, plan, shell",
                                    mode_arg
                                ),
                            });
                        }
                    }
                } else {
                    // Show current mode
                    let mode_str = match self.mode {
                        Mode::Agent => "normal",
                        Mode::Plan => "plan",
                        Mode::Shell => "shell",
                    };
                    self.messages.push(Message {
                        role: Role::System,
                        content: format!(
                            "Current mode: {}\nUsage: /mode <normal|plan|shell>",
                            mode_str
                        ),
                    });
                }
            }
            "/shell" | "/sh" => {
                // Launch interactive shell mode
                // 1. Clear terminal for fresh shell session
                let stdout = crate::bindings::wasi::cli::stdout::get_stdout();
                let _ = stdout.blocking_write_and_flush(b"\x1b[2J\x1b[H"); // Clear screen, cursor home

                // 2. Get fresh stdin/stdout/stderr for shell
                let stdin = crate::bindings::wasi::cli::stdin::get_stdin();
                let stdout = crate::bindings::wasi::cli::stdout::get_stdout();
                let stderr = crate::bindings::wasi::cli::stderr::get_stderr();

                // 3. Create execution environment
                let env = crate::bindings::shell::unix::command::ExecEnv {
                    cwd: "/".to_string(),
                    vars: vec![
                        ("HOME".to_string(), "/".to_string()),
                        ("PATH".to_string(), "/bin:/usr/bin".to_string()),
                        ("TERM".to_string(), "xterm-256color".to_string()),
                    ],
                };

                // 4. Run brush-shell (blocks until exit)
                let _exit_code = crate::bindings::shell::unix::command::run(
                    "sh",
                    &[],
                    &env,
                    stdin,
                    stdout,
                    stderr,
                );

                // 5. Restore TUI - clear screen and redraw
                let stdout = crate::bindings::wasi::cli::stdout::get_stdout();
                let _ = stdout.blocking_write_and_flush(b"\x1b[2J\x1b[H");
                let _ = self.terminal.clear();

                self.messages.push(Message {
                    role: Role::System,
                    content: "Returned from shell".to_string(),
                });
            }
            "/key" => {
                self.state = AppState::NeedsApiKey;
                self.messages.push(Message {
                    role: Role::System,
                    content: "Enter API key:".to_string(),
                });
            }
            "/config" => {
                // Display current configuration
                let api_key_status = if self.has_api_key() {
                    "configured ✓"
                } else {
                    "not set"
                };

                self.messages.push(Message {
                    role: Role::System,
                    content: format!(
                        "Configuration:\n  Provider: {}\n  Model: {}\n  API Key: {}\n  Theme: {}\n  Aux Panel: {}",
                        self.provider_name(),
                        self.model_name(),
                        api_key_status,
                        self.config.ui.theme,
                        if self.config.ui.aux_panel { "enabled" } else { "disabled" }
                    ),
                });
            }

            "/theme" => {
                // Change theme - usage: /theme dark|light|gruvbox|catppuccin
                if let Some(theme_name) = parts.get(1) {
                    let valid_themes = ["dark", "light", "gruvbox", "catppuccin", "tokyo-night"];
                    if valid_themes.contains(&theme_name.to_lowercase().as_str()) {
                        self.config.ui.theme = theme_name.to_string();
                        let _ = self.config.save();
                        self.messages.push(Message {
                            role: Role::System,
                            content: format!("Theme changed to: {}", theme_name),
                        });
                    } else {
                        self.messages.push(Message {
                            role: Role::System,
                            content: format!(
                                "Unknown theme: {}. Available: {}",
                                theme_name,
                                valid_themes.join(", ")
                            ),
                        });
                    }
                } else {
                    self.messages.push(Message {
                        role: Role::System,
                        content: format!(
                            "Current theme: {}. Usage: /theme <name>\nAvailable: dark, light, gruvbox, catppuccin",
                            self.config.ui.theme
                        ),
                    });
                }
            }
            "/clear" => {
                self.messages.clear();
                self.messages.push(Message {
                    role: Role::System,
                    content: "Messages cleared.".to_string(),
                });
            }
            "/quit" | "/q" => {
                self.should_quit = true;
            }
            _ => {
                self.messages.push(Message {
                    role: Role::System,
                    content: format!("Unknown: {}. Try /help", cmd),
                });
            }
        }
    }
}
