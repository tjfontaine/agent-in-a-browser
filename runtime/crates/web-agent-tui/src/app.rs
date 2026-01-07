//! Main application state and event loop
//!
//! Manages the TUI lifecycle: init, render, input handling, cleanup.

use ratatui::Terminal;

use crate::backend::{enter_alternate_screen, leave_alternate_screen, WasiBackend};
use crate::bridge::{
    get_local_tool_definitions, get_system_message, mcp_client::McpError, McpClient,
};

use crate::config::{self, Config, ServersConfig};
use crate::input::InputBuffer;
use crate::servers::{RemoteServerEntry, ServerConnectionStatus, ServerManager};

use crate::ui::{
    render_ui, AuxContent, AuxContentKind, Mode, Overlay, ServerManagerView, ServerStatus,
};
use crate::PollableRead;
use crate::{poll, subscribe_duration, AgentCore};
use std::io::Write;

/// App state enumeration
#[derive(Clone, Copy, Debug, PartialEq)]
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
pub struct App<R: PollableRead, W: Write> {
    /// Current mode
    pub(crate) mode: Mode,
    /// Current state
    pub(crate) state: AppState,
    /// Input buffer with readline-like editing
    pub(crate) input: InputBuffer,
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
    /// Pending message to send after API key is set
    pending_message: Option<String>,
    /// Auxiliary panel content
    pub(crate) aux_content: AuxContent,
    /// Server connection status (ui display version)
    pub(crate) server_status: ServerStatus,
    /// Flag to cancel current operation
    cancelled: bool,
    /// Current overlay (modal popup)
    pub(crate) overlay: Option<Overlay>,
    /// Unified timeline: messages and display items in chronological order
    pub(crate) timeline: Vec<crate::display::TimelineEntry>,

    /// The Core Agent logic
    pub(crate) agent: AgentCore,
}

impl<R: PollableRead, W: Write> App<R, W> {
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

        // Initialize AgentCore
        let mut agent = AgentCore::new(config, mcp_client);

        // Load saved MCP servers from config and add to agent
        let servers_config = ServersConfig::load();
        let remote_servers: Vec<RemoteServerEntry> = servers_config
            .servers
            .into_iter()
            .map(|s| RemoteServerEntry {
                id: s.id,
                name: s.name,
                url: s.url,
                status: ServerConnectionStatus::Disconnected,
                tools: Vec::new(),
                bearer_token: s.api_key,
            })
            .collect();

        agent.remote_servers_mut().extend(remote_servers);

        Self {
            mode: Mode::Agent,
            state: AppState::Ready,
            input: InputBuffer::new(),
            history: loaded_history,
            history_index: loaded_history_len,
            terminal,
            stdin,
            should_quit: false,
            pending_message: None,
            aux_content: AuxContent::default(),
            server_status: ServerStatus {
                local_connected: false, // Will be set after MCP init
                local_tool_count: 0,
                remote_servers: Vec::new(),
            },
            cancelled: false,
            overlay: None,
            timeline: vec![crate::display::TimelineEntry::info(
                "Welcome to Agent in a Browser! Type /help for commands.",
            )],
            agent,
        }
    }

    /// Add an info notice to timeline (UI-only, never sent to API)
    fn notice(&mut self, text: impl Into<String>) {
        self.timeline
            .push(crate::display::TimelineEntry::info(text));
    }

    /// Add a warning notice to timeline
    #[allow(dead_code)]
    fn notice_warning(&mut self, text: impl Into<String>) {
        self.timeline
            .push(crate::display::TimelineEntry::warning(text));
    }

    /// Add an error notice to timeline
    fn notice_error(&mut self, text: impl Into<String>) {
        self.timeline
            .push(crate::display::TimelineEntry::error(text));
    }

    /// Add a user message to both agent history and timeline
    fn add_user_message(&mut self, content: &str) {
        self.agent.add_user_message(content);
        self.timeline
            .push(crate::display::TimelineEntry::user_message(content));
    }

    /// Add an assistant message to both agent history and timeline
    fn add_assistant_message(&mut self, content: &str) {
        self.agent.add_assistant_message(content);
        self.timeline
            .push(crate::display::TimelineEntry::assistant_message(content));
    }

    /// Update the last assistant message in both agent history and timeline
    #[allow(dead_code)]
    fn update_last_assistant(&mut self, content: &str) {
        self.agent.update_last_assistant(content);
        // Update the last assistant message in the timeline
        if let Some(last) = self.timeline.last_mut() {
            if let crate::display::TimelineEntry::Message(ref mut msg) = last {
                if msg.role == crate::Role::Assistant {
                    msg.content = content.to_string();
                }
            }
        }
    }

    /// Main run loop
    pub fn run(&mut self) -> i32 {
        // Setup
        self.setup_terminal();

        // Initial render
        self.render();

        // Auto-connect all predefined MCP servers
        self.auto_connect_servers();

        // Initialize sandbox MCP (local tools)
        self.init_sandbox_mcp();

        self.render(); // Re-render to show connection results

        // Main loop: input then render
        // (This order ensures resize events are processed before drawing)
        while !self.should_quit {
            // During streaming, use poll-based waiting on stdin + timer
            // This allows us to respond to input while waiting for stream data
            if self.state == AppState::Streaming {
                // Create pollables: stdin (for user input) and timer (for stream polling)
                let stdin_pollable = self.stdin.subscribe();
                let timer_pollable = subscribe_duration(10_000_000); // 10ms in nanoseconds

                // Wait for either stdin or timer
                let ready = poll(&[&stdin_pollable, &timer_pollable]);

                // If stdin is ready (index 0), handle input
                if ready.iter().any(|&idx| idx == 0) {
                    self.handle_streaming_input();
                }
                // Timer always fires after 10ms, we'll poll stream below
            } else {
                // Handle input (including resize events from stdin)
                self.handle_input();
            }

            // Poll active stream if streaming
            self.poll_stream();

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
        self.agent.model()
    }

    /// Get the current provider name
    pub fn provider_name(&self) -> &str {
        self.agent.provider()
    }

    /// Check if API key is set for the current provider
    pub fn has_api_key(&self) -> bool {
        self.agent.has_api_key()
    }

    /// Get the API key for the current provider
    pub fn get_api_key(&self) -> Option<&str> {
        self.agent.api_key()
    }

    /// Set the API key for the current provider
    pub fn set_api_key(&mut self, key: &str) {
        self.agent.set_api_key(key);
    }

    /// Set the provider (anthropic or openai)
    pub fn set_provider(&mut self, provider: &str) {
        self.agent.set_provider(provider);
    }

    /// Set the model for the current provider
    pub fn set_model(&mut self, model: &str) {
        self.agent.set_model(model);
    }

    /// Get the base URL for the current provider
    pub fn get_base_url(&self) -> Option<&str> {
        self.agent
            .config()
            .current_provider_settings()
            .base_url
            .as_deref()
    }

    /// Set the base URL for the current provider
    pub fn set_base_url(&mut self, url: &str) {
        self.agent.set_base_url(url);
    }

    fn render(&mut self) {
        let mode = self.mode;
        let state = self.state;
        let input = self.input.clone();
        let messages = self.agent.messages().to_vec();
        let aux_content = self.aux_content.clone();

        // Sync server status from agent core to UI state
        let agent_status = self.agent.server_status();
        let remote_servers = self.agent.remote_servers().to_vec();

        let ui_remote_servers: Vec<crate::ui::RemoteServer> = remote_servers
            .iter()
            .map(|s| crate::ui::RemoteServer {
                name: s.name.clone(),
                url: s.url.clone(),
                connected: s.status == crate::servers::ServerConnectionStatus::Connected,
                tool_count: s.tools.len(),
            })
            .collect();

        self.server_status = crate::ui::ServerStatus {
            local_connected: agent_status.local_connected,
            local_tool_count: agent_status.local_tool_count,
            remote_servers: ui_remote_servers,
        };
        let server_status = self.server_status.clone();

        let model_name = self.agent.model().to_string();
        let overlay = self.overlay.clone();
        let display_items = self.timeline.clone();

        let _ = self.terminal.draw(|frame| {
            render_ui(
                frame,
                mode,
                state,
                input.text(),
                input.cursor_pos(),
                &messages,
                &display_items,
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

    /// Handle input during streaming - only look for ESC to cancel
    fn handle_streaming_input(&mut self) {
        // Try to read without blocking
        let mut buf = [0u8; 32];
        match self.stdin.try_read(&mut buf) {
            Ok(0) => {} // No data
            Ok(n) => {
                let bytes = &buf[..n];
                // Check for ESC key (0x1B) to cancel streaming
                if bytes.contains(&0x1B) {
                    // Cancel active stream
                    self.agent.cancel();
                    self.state = AppState::Ready;
                }
            }
            Err(_) => {} // Would block or error
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
                    self.timeline
                        .push(crate::display::TimelineEntry::info("Exiting shell mode."));
                } else {
                    self.should_quit = true;
                }
                true
            }
            // Ctrl+N - switch to normal (agent) mode
            0x0E => {
                if self.mode != Mode::Agent {
                    self.mode = Mode::Agent;
                    self.timeline.push(crate::display::TimelineEntry::info(
                        "Switched to normal mode.",
                    ));
                }
                true
            }
            // Ctrl+P - toggle plan mode
            0x10 => {
                if self.mode == Mode::Plan {
                    self.mode = Mode::Agent;
                    self.timeline
                        .push(crate::display::TimelineEntry::info("Exiting plan mode."));
                } else if self.mode != Mode::Shell {
                    self.mode = Mode::Plan;
                    self.timeline.push(crate::display::TimelineEntry::info(
                        "Entering plan mode. Type 'go' to execute plan, or /mode normal to exit.",
                    ));
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
                self.timeline.push(crate::display::TimelineEntry::info(
                    "API key entry cancelled.",
                ));
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

                self.timeline.push(crate::display::TimelineEntry::info(
                    "API key set and saved.",
                ));
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
                        // Handle slash commands FIRST - don't add to history or send to AI
                        if input.starts_with('/') {
                            self.handle_slash_command(&input);
                            return;
                        }

                        // Check for consecutive duplicate message submission
                        // Simply reject if the last user message is identical (trimmed)
                        // This prevents both input replays and rapid double-sends
                        let is_duplicate = self
                            .agent
                            .messages()
                            .iter()
                            .rev()
                            .find(|m| m.role == crate::agent_core::Role::User)
                            .map(|user_msg| user_msg.content.trim() == input.trim())
                            .unwrap_or(false);

                        // If not a duplicate, process it (send_to_ai will add it if needed via agent.send)
                        // If it IS a duplicate, we might still want to retry if previous failed?
                        // Current logic: strict duplicate prevention for immediate re-send.
                        if is_duplicate {
                            // Duplicate detected - skip
                            return;
                        }

                        // Always update history index to end
                        self.history_index = self.agent.messages().len();

                        // Regular message - send to AI
                        self.send_to_ai(&input);
                    }
                }
            }
        }
    }

    /// Execute a shell command via MCP shell_eval
    fn execute_shell_command(&mut self, command: &str) {
        // Show the command with shell prompt
        self.add_user_message(&format!("$ {}", command));

        // Handle shell-local commands
        if command.trim() == "exit" {
            self.mode = Mode::Agent;
            self.timeline
                .push(crate::display::TimelineEntry::info("Exiting shell mode."));
            return;
        }

        if command.trim() == "clear" {
            self.agent.clear_messages();
            self.timeline.clear();
            self.timeline.push(crate::display::TimelineEntry::info(
                "Shell mode - type 'exit' or ^D to return",
            ));
            return;
        }

        self.state = AppState::Processing;

        // Call shell_eval via MCP
        let args = serde_json::json!({
            "command": command
        });

        match self.agent.mcp_client().call_tool("shell_eval", args) {
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

                // Use Assistant role for tool output since we don't have Tool/System roles in AgentCore
                self.add_assistant_message(&display);
            }
            Err(e) => {
                self.timeline
                    .push(crate::display::TimelineEntry::error(format!(
                        "Error: {}",
                        e
                    )));
            }
        }

        self.state = AppState::Ready;
    }

    fn send_to_ai(&mut self, message: &str) {
        if self.agent.is_streaming() {
            return;
        }

        let input = message.trim();
        if input.is_empty() {
            return;
        }

        // Check for API key
        if !self.agent.has_api_key() {
            self.add_user_message(input);
            self.timeline.push(crate::display::TimelineEntry::info(
                "Please set your API key to proceed.",
            ));
            self.pending_message = Some(input.to_string());
            self.state = AppState::NeedsApiKey;
            self.overlay = Some(crate::ui::Overlay::ServerManager(
                crate::ui::server_manager::ServerManagerView::SetToken {
                    server_id: "__local__".to_string(),
                    token_input: String::new(),
                    error: None,
                },
            ));
            return;
        }

        self.state = AppState::Processing;
        self.cancelled = false;

        // Initialize agent if needed
        if self.agent.rig_agent().is_none() {
            // Collect tools first (requires mutable borrow of self)
            let tools = self.collect_all_tools();
            let preambles = get_system_message(&tools);

            // Now borrow config immutably for settings
            let config = self.agent.config();
            let settings = config.current_provider_settings();
            let api_key = settings.api_key.clone().unwrap_or_default();
            let model = settings.model.clone();
            let api_format = config.current_api_format().to_string();
            let base_url = settings.base_url.clone();
            let mcp_client = self.agent.mcp_client().clone();

            let agent_result = crate::bridge::rig_agent::RigAgent::from_config(
                &api_key,
                &model,
                &api_format,
                base_url.as_deref(),
                &preambles.content,
                mcp_client,
            );

            match agent_result {
                Ok(agent) => {
                    self.agent.set_rig_agent(agent);
                }
                Err(e) => {
                    self.timeline
                        .push(crate::display::TimelineEntry::error(e.to_string()));
                    self.state = AppState::Ready;
                    return;
                }
            }
        }

        // Determine if we should start a new stream or retry the last message
        // If the last message in history is identical to input and role is User, assume retry.
        let last_is_input = self
            .agent
            .messages()
            .last()
            .map(|m| m.role == crate::agent_core::Role::User && m.content == input)
            .unwrap_or(false);

        // Set state to Streaming BEFORE the potentially blocking HTTP call
        // so the UI updates immediately (especially important on WebKit/Safari
        // where XMLHttpRequest is synchronous and can block)
        self.state = AppState::Streaming;

        let result = if last_is_input {
            self.agent.start_stream(input)
        } else {
            self.agent.send(input)
        };

        if let Err(e) = result {
            self.timeline.push(crate::display::TimelineEntry::error(e));
            self.state = AppState::Ready;
        }
    }

    /// Poll the active stream and update the assistant message.
    /// Called on each tick while in Streaming state.
    /// Uses poll-once pattern to allow UI updates between chunks.
    fn poll_stream(&mut self) {
        if self.state != AppState::Streaming {
            return;
        }

        self.agent.poll_stream();

        if !self.agent.is_streaming() {
            self.state = AppState::Ready;
        }

        while let Some(event) = self.agent.pop_event() {
            match event {
                crate::events::AgentEvent::StateChange { .. } => {}
                crate::events::AgentEvent::Ready => {
                    self.state = AppState::Ready;
                }
                crate::events::AgentEvent::StreamCancelled => {
                    self.timeline.push(crate::display::TimelineEntry::warning(
                        "Streaming cancelled.",
                    ));
                    self.state = AppState::Ready;
                }
                crate::events::AgentEvent::Notice { text, kind } => match kind {
                    crate::display::NoticeKind::Info => {
                        self.timeline
                            .push(crate::display::TimelineEntry::info(text));
                    }
                    crate::display::NoticeKind::Warning => {
                        self.timeline
                            .push(crate::display::TimelineEntry::warning(text));
                    }
                    crate::display::NoticeKind::Error => {
                        self.timeline
                            .push(crate::display::TimelineEntry::error(text));
                    }
                },

                // Stream events
                crate::events::AgentEvent::StreamStart => {
                    // Add empty assistant message to timeline for streaming
                    self.timeline
                        .push(crate::display::TimelineEntry::assistant_message(""));
                }
                crate::events::AgentEvent::StreamChunk { text } => {
                    // Update the last assistant message in the timeline
                    if let Some(last) = self.timeline.last_mut() {
                        if let crate::display::TimelineEntry::Message(ref mut msg) = last {
                            if msg.role == crate::Role::Assistant {
                                msg.content = text;
                            }
                        }
                    }
                }
                crate::events::AgentEvent::StreamComplete { final_text } => {
                    // Update the last assistant message with final content
                    if let Some(last) = self.timeline.last_mut() {
                        if let crate::display::TimelineEntry::Message(ref mut msg) = last {
                            if msg.role == crate::Role::Assistant {
                                msg.content = final_text;
                            }
                        }
                    }
                }
                crate::events::AgentEvent::StreamError { error } => {
                    self.timeline
                        .push(crate::display::TimelineEntry::error(error));
                    self.state = AppState::Ready;
                }

                // Tool events
                crate::events::AgentEvent::ToolActivity {
                    tool_name,
                    status: _,
                } => {
                    // Only show Calling status for now
                    self.timeline
                        .push(crate::display::TimelineEntry::tool_activity(tool_name));
                }
                crate::events::AgentEvent::ToolResult { .. } => {}

                // Message events
                crate::events::AgentEvent::UserMessage { content } => {
                    // Add user message to timeline
                    self.timeline
                        .push(crate::display::TimelineEntry::user_message(content));
                }
            }
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
                        let max_items = 2 + self.agent.remote_servers_mut().len(); // Local + Add New + remotes
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
                                    if let Some(server) = self.agent.remote_servers_mut().get(idx) {
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
                                            // Check if already connected
                                            if let Some(server) = self
                                                .agent
                                                .remote_servers_mut()
                                                .iter()
                                                .find(|s| s.id == sid)
                                            {
                                                if server.status
                                                    == ServerConnectionStatus::Connected
                                                {
                                                    // Disconnect
                                                    self.toggle_server_connection(&sid);
                                                } else {
                                                    // Actually connect
                                                    self.connect_remote_server_by_id(&sid);
                                                }
                                            }
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
                                // Enter - add server and try to connect
                                let url = url_input.clone();
                                if !url.is_empty() {
                                    // Add the server first
                                    self.add_remote_server(&url);

                                    // Get the newly added server's ID
                                    if let Some(server) = self.agent.remote_servers_mut().last() {
                                        let server_id = server.id.clone();

                                        // Try auto-connect
                                        self.try_connect_new_server_in_wizard(&server_id);
                                    } else {
                                        // Fallback: just go to list
                                        self.overlay = Some(Overlay::ServerManager(
                                            ServerManagerView::ServerList { selected: 0 },
                                        ));
                                    }
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
                                // Enter - set token and try to connect
                                let sid = server_id.clone();
                                let token = token_input.clone();
                                if !token.is_empty() {
                                    self.set_server_token(&sid, &token);
                                    // Try to connect with the new token
                                    self.try_connect_new_server_in_wizard(&sid);
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
                        if let Some((provider_id, _name, _base_url)) = PROVIDERS.get(*selected) {
                            // Load current settings for this provider
                            let settings = self.agent.config().providers.get(provider_id);
                            let saved_model = settings.model.clone();
                            let saved_base_url = settings.base_url.clone().unwrap_or_default();
                            let saved_api_key = settings.api_key.clone().unwrap_or_default();

                            // Get default model if not set
                            let prefilled_model = if saved_model.is_empty() {
                                crate::ui::server_manager::get_models_for_provider(provider_id)
                                    .first()
                                    .map(|(id, _)| id.to_string())
                                    .unwrap_or_default()
                            } else {
                                saved_model
                            };

                            // Pre-select API format based on provider (kept for future use)
                            let api_format = match *provider_id {
                                "anthropic" => 1,
                                "gemini" | "google" => 2,
                                "openrouter" => 3,
                                _ => 0,
                            };

                            self.overlay = Some(Overlay::ProviderWizard {
                                step: ProviderWizardStep::ProviderConfig,
                                selected_provider: *selected,
                                selected_api_format: api_format,
                                selected_model: 0,
                                selected_field: 0, // Start at Model field
                                base_url_input: saved_base_url,
                                model_input: prefilled_model,
                                api_key_input: saved_api_key,
                                fetched_models: None,
                                standalone: false,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Overlay::ProviderWizard {
                step,
                selected_provider,
                selected_api_format: _,
                selected_model,
                selected_field,
                base_url_input,
                model_input,
                api_key_input,
                fetched_models,
                standalone,
            } => {
                use crate::ui::server_manager::{
                    get_models_for_provider, ProviderWizardStep, PROVIDERS,
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
                                // Enter - go to ProviderConfig to view/edit settings
                                if let Some((provider_id, _, _)) = PROVIDERS.get(*selected_provider)
                                {
                                    // Load current settings for this provider
                                    let settings = self.agent.config().providers.get(provider_id);
                                    *model_input = settings.model.clone();
                                    *base_url_input = settings.base_url.clone().unwrap_or_default();
                                    *api_key_input = settings.api_key.clone().unwrap_or_default();

                                    // If model is empty, use default from provider's model list
                                    if model_input.is_empty() {
                                        *model_input = get_models_for_provider(provider_id)
                                            .first()
                                            .map(|(id, _)| id.to_string())
                                            .unwrap_or_default();
                                    }

                                    *step = ProviderWizardStep::ProviderConfig;
                                    *selected_field = 0; // Start at Model field
                                }
                            }
                            _ => {}
                        }
                    }
                    ProviderWizardStep::ProviderConfig => {
                        // Config view with selectable fields:
                        // 0=Model, 1=BaseURL, 2=ApiKey, 3=Apply&Save, 4=Save, 5=Back
                        const MAX_FIELDS: usize = 6;

                        match byte {
                            0x1B => {
                                // Esc - go back to provider selection
                                *step = ProviderWizardStep::SelectProvider;
                            }
                            0xF0 | 0x6B => {
                                // Up arrow
                                if *selected_field > 0 {
                                    *selected_field -= 1;
                                }
                            }
                            0xF1 | 0x6A => {
                                // Down arrow
                                if *selected_field + 1 < MAX_FIELDS {
                                    *selected_field += 1;
                                }
                            }
                            0x0D => {
                                // Enter - action depends on selected field
                                match *selected_field {
                                    0 => {
                                        // Edit Model
                                        *selected_model = 0; // Reset selection
                                        *step = ProviderWizardStep::EditModel;
                                    }
                                    1 => {
                                        // Edit Base URL
                                        *step = ProviderWizardStep::EditBaseUrl;
                                    }
                                    2 => {
                                        // Edit API Key
                                        *step = ProviderWizardStep::EditApiKey;
                                    }
                                    3 => {
                                        // Apply & Save - set as default and save
                                        let (provider_id, _, _) = PROVIDERS
                                            .get(*selected_provider)
                                            .unwrap_or(&("custom", "Custom", None));
                                        let provider_id = provider_id.to_string();
                                        let model = model_input.clone();
                                        let base_url = base_url_input.clone();
                                        let api_key = api_key_input.clone();

                                        // Close overlay
                                        self.overlay = None;

                                        // Set as default provider
                                        self.set_provider(&provider_id);

                                        // Save model
                                        if !model.is_empty() {
                                            self.set_model(&model);
                                        }

                                        // Save base URL
                                        if !base_url.is_empty() {
                                            self.agent
                                                .config_mut()
                                                .current_provider_settings_mut()
                                                .base_url = Some(base_url);
                                        } else {
                                            self.agent
                                                .config_mut()
                                                .current_provider_settings_mut()
                                                .base_url = None;
                                        }

                                        // Save API key
                                        if !api_key.is_empty() {
                                            self.set_api_key(&api_key);
                                        }

                                        let _ = self.agent.config().save();

                                        self.notice(format!(
                                            "Provider switched to {} with model {}",
                                            provider_id,
                                            self.model_name()
                                        ));
                                    }
                                    4 => {
                                        // Save only - save without changing default provider
                                        let (provider_id, _, _) = PROVIDERS
                                            .get(*selected_provider)
                                            .unwrap_or(&("custom", "Custom", None));
                                        let provider_id = provider_id.to_string();
                                        let model = model_input.clone();
                                        let base_url = base_url_input.clone();
                                        let api_key = api_key_input.clone();

                                        // Close overlay
                                        self.overlay = None;

                                        // Save to provider settings (without setting as default)
                                        {
                                            let settings = self
                                                .agent
                                                .config_mut()
                                                .providers
                                                .get_or_create(&provider_id);
                                            if !model.is_empty() {
                                                settings.model = model;
                                            }
                                            if !base_url.is_empty() {
                                                settings.base_url = Some(base_url);
                                            } else {
                                                settings.base_url = None;
                                            }
                                            if !api_key.is_empty() {
                                                settings.api_key = Some(api_key);
                                            }
                                        }

                                        let _ = self.agent.config_mut().save();

                                        self.notice(format!(
                                            "Saved settings for {} (model: {})",
                                            provider_id,
                                            self.agent.config().providers.get(&provider_id).model
                                        ));
                                    }
                                    5 => {
                                        // Back - return to provider selection without saving
                                        *step = ProviderWizardStep::SelectProvider;
                                    }
                                    _ => {}
                                }
                            }
                            _ => {}
                        }
                    }
                    ProviderWizardStep::EditModel => {
                        // Model selection with list + custom input
                        // When not fetched: [0]=Refresh, [1..N]=static models, [N+1]=custom
                        // When fetched: [0..N-1]=API models, [N]=custom
                        let (provider_id, _, _) = PROVIDERS
                            .get(*selected_provider)
                            .unwrap_or(&("openai", "OpenAI", None));

                        // Use fetched models if available, otherwise static
                        let static_models = get_models_for_provider(provider_id);
                        let has_fetched = fetched_models.is_some();
                        let model_count = if let Some(models) = fetched_models.as_ref() {
                            models.len()
                        } else {
                            static_models.len()
                        };
                        // When not fetched, add 1 for [Refresh] option at top
                        let offset = if has_fetched { 0 } else { 1 };
                        let max_items = model_count + offset + 1; // +1 for custom option
                        let is_refresh_selected = !has_fetched && *selected_model == 0;
                        let is_custom_selected = *selected_model == model_count + offset;

                        match byte {
                            0x1B => {
                                // Esc - back to config view (or close in standalone mode)
                                if *standalone {
                                    self.overlay = None;
                                } else {
                                    *step = ProviderWizardStep::ProviderConfig;
                                }
                            }
                            0xF0 | 0x6B => {
                                if *selected_model > 0 {
                                    *selected_model -= 1;
                                }
                            }
                            0xF1 | 0x6A => {
                                if *selected_model + 1 < max_items {
                                    *selected_model += 1;
                                }
                            }
                            0x0D => {
                                // Enter - depends on selection
                                if is_refresh_selected {
                                    // Refresh selected - check if API key is set
                                    let provider_id = provider_id.to_string();
                                    let api_key = api_key_input.clone();
                                    let base_url = if base_url_input.is_empty() {
                                        None
                                    } else {
                                        Some(base_url_input.clone())
                                    };

                                    // Use wizard's api_key_input, falling back to config
                                    let key = if api_key.is_empty() {
                                        self.agent
                                            .config()
                                            .providers
                                            .get(&provider_id)
                                            .api_key
                                            .clone()
                                    } else {
                                        Some(api_key)
                                    };

                                    if key.is_some() {
                                        self.handle_wizard_model_refresh(
                                            &provider_id,
                                            key.as_deref(),
                                            base_url.as_deref(),
                                        );
                                    } else {
                                        // No API key - redirect to API key entry
                                        self.timeline.push(crate::display::TimelineEntry::info(
                                            "Please enter an API key first.",
                                        ));
                                        *step = ProviderWizardStep::EditApiKey;
                                    }
                                } else if is_custom_selected {
                                    // Custom input - only proceed if not empty
                                    if !model_input.is_empty() {
                                        if *standalone {
                                            // Clone before setting overlay to None
                                            let model_to_set = model_input.clone();
                                            self.overlay = None;
                                            self.set_model(&model_to_set);
                                            self.notice(format!(
                                                "Model changed to: {}",
                                                model_to_set
                                            ));
                                        } else {
                                            *step = ProviderWizardStep::ProviderConfig;
                                        }
                                    }
                                } else {
                                    // Model from list - adjust index for offset
                                    let model_idx = *selected_model - offset;
                                    let model_id = if let Some(models) = fetched_models.as_ref() {
                                        models.get(model_idx).map(|(id, _)| id.clone())
                                    } else {
                                        static_models.get(model_idx).map(|(id, _)| id.to_string())
                                    };
                                    if let Some(id) = model_id {
                                        if *standalone {
                                            // Clone before setting overlay to None
                                            self.overlay = None;
                                            self.set_model(&id);
                                            self.notice(format!("Model changed to: {}", id));
                                        } else {
                                            *model_input = id;
                                            *step = ProviderWizardStep::ProviderConfig;
                                        }
                                    }
                                }
                            }
                            0x7F | 0x08 => {
                                // Backspace - only when custom is selected
                                if is_custom_selected {
                                    model_input.pop();
                                }
                            }
                            0x72 => {
                                // 'r' - refresh models from API (same as selecting Refresh option)
                                let provider_id = provider_id.to_string();
                                let api_key = api_key_input.clone();
                                let base_url = if base_url_input.is_empty() {
                                    None
                                } else {
                                    Some(base_url_input.clone())
                                };

                                let key = if api_key.is_empty() {
                                    self.agent
                                        .config()
                                        .providers
                                        .get(&provider_id)
                                        .api_key
                                        .clone()
                                } else {
                                    Some(api_key)
                                };

                                if key.is_some() {
                                    self.handle_wizard_model_refresh(
                                        &provider_id,
                                        key.as_deref(),
                                        base_url.as_deref(),
                                    );
                                } else {
                                    // No API key - redirect to API key entry
                                    self.timeline.push(crate::display::TimelineEntry::info(
                                        "Please enter an API key first.",
                                    ));
                                    *step = ProviderWizardStep::EditApiKey;
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
                    ProviderWizardStep::EditBaseUrl => {
                        match byte {
                            0x1B => {
                                // Esc - back to config view
                                *step = ProviderWizardStep::ProviderConfig;
                            }
                            0x0D => {
                                // Enter - save and return to config (empty is valid = use default)
                                *step = ProviderWizardStep::ProviderConfig;
                            }
                            0x7F | 0x08 => {
                                base_url_input.pop();
                            }
                            b if b >= 0x20 && b < 0x7F => {
                                base_url_input.push(b as char);
                            }
                            _ => {}
                        }
                    }
                    ProviderWizardStep::EditApiKey => {
                        match byte {
                            0x1B => {
                                // Esc - back to config view
                                *step = ProviderWizardStep::ProviderConfig;
                            }
                            0x0D => {
                                // Enter - save and return to config
                                *step = ProviderWizardStep::ProviderConfig;
                            }
                            0x7F | 0x08 => {
                                api_key_input.pop();
                            }
                            b if b >= 0x20 && b < 0x7F => {
                                api_key_input.push(b as char);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    // === Model Refresh Methods ===

    /// Handle model refresh for ProviderWizard overlay
    fn handle_wizard_model_refresh(
        &mut self,
        provider_id: &str,
        api_key: Option<&str>,
        base_url: Option<&str>,
    ) {
        use crate::bridge::models_api::fetch_models_for_provider;

        if let Some(key) = api_key {
            self.notice("Fetching models from API...".to_string());

            match fetch_models_for_provider(provider_id, key, base_url) {
                Ok(models) => {
                    let model_names: Vec<(String, String)> =
                        models.into_iter().map(|m| (m.id, m.name)).collect();
                    let count = model_names.len();

                    // Update ProviderWizard overlay with fetched models
                    if let Some(Overlay::ProviderWizard {
                        selected_model,
                        fetched_models,
                        ..
                    }) = &mut self.overlay
                    {
                        *fetched_models = Some(model_names);
                        *selected_model = 0; // Move to first model
                    }

                    self.notice(format!("Loaded {} models from API.", count));
                }
                Err(e) => {
                    self.notice_error(format!("Failed to fetch models: {}. Using static list.", e));
                }
            }
        } else {
            self.notice("No API key set. Configure API key first, then press 'r' to refresh.");
        }
    }

    // === Server Management Methods ===

    fn add_remote_server(&mut self, url: &str) {
        ServerManager::add_server(self.agent.remote_servers_mut(), url);
        self.save_servers();
    }

    fn remove_remote_server(&mut self, id: &str) {
        ServerManager::remove_server(self.agent.remote_servers_mut(), id);
        self.save_servers();
    }

    fn set_server_token(&mut self, id: &str, token: &str) {
        ServerManager::set_token(self.agent.remote_servers_mut(), id, token);
        self.save_servers();
    }

    /// Try to connect a newly added server in the wizard context
    /// On success: close overlay and show success message
    /// On OAuth required: trigger OAuth flow, then return to list
    /// On other failure: show SetToken dialog for bearer key entry
    fn try_connect_new_server_in_wizard(&mut self, id: &str) {
        let idx = self
            .agent
            .remote_servers_mut()
            .iter()
            .position(|s| s.id == id);
        if let Some(idx) = idx {
            self.agent.remote_servers_mut()[idx].status = ServerConnectionStatus::Connecting;
            let server = &self.agent.remote_servers_mut()[idx];
            let server_name = server.name.clone();
            let server_id = server.id.clone();

            match ServerManager::connect_server(server) {
                Ok(tools) => {
                    let tool_count = tools.len();
                    self.agent.remote_servers_mut()[idx].status = ServerConnectionStatus::Connected;
                    self.agent.remote_servers_mut()[idx].tools = tools;
                    self.notice(format!(
                        "Connected to '{}'. {} tools available.",
                        server_name, tool_count
                    ));
                    // Success - close wizard
                    self.overlay = None;
                }
                Err(McpError::OAuthRequired(server_url)) => {
                    // OAuth required - trigger OAuth flow
                    self.notice("Server requires OAuth. Opening authorization popup...");

                    let redirect_uri = format!(
                        "{}/oauth-callback",
                        std::env::var("ORIGIN")
                            .unwrap_or_else(|_| "https://agent.edge-agent.dev".to_string())
                    );
                    let client_id = server_id.clone();

                    use crate::bridge::oauth_client::perform_oauth_flow;
                    match perform_oauth_flow(&server_url, &server_id, &client_id, &redirect_uri) {
                        Ok(token_response) => {
                            self.agent.remote_servers_mut()[idx].bearer_token =
                                Some(token_response.access_token.clone());
                            self.save_servers();

                            // Retry connection with token
                            let server = &self.agent.remote_servers_mut()[idx];
                            match ServerManager::connect_server(server) {
                                Ok(tools) => {
                                    let tool_count = tools.len();
                                    self.agent.remote_servers_mut()[idx].status =
                                        ServerConnectionStatus::Connected;
                                    self.agent.remote_servers_mut()[idx].tools = tools;
                                    self.notice(format!(
                                        "Connected to '{}'. {} tools available.",
                                        server_name, tool_count
                                    ));
                                    self.overlay = None;
                                }
                                Err(e) => {
                                    self.agent.remote_servers_mut()[idx].status =
                                        ServerConnectionStatus::Error(e.to_string());
                                    self.notice(format!("Connection failed after OAuth: {}", e));
                                    self.overlay = Some(Overlay::ServerManager(
                                        ServerManagerView::ServerList { selected: 0 },
                                    ));
                                }
                            }
                        }
                        Err(oauth_err) => {
                            self.agent.remote_servers_mut()[idx].status =
                                ServerConnectionStatus::Error(oauth_err.to_string());
                            self.notice(format!("OAuth failed: {}", oauth_err));
                            self.overlay =
                                Some(Overlay::ServerManager(ServerManagerView::ServerList {
                                    selected: 0,
                                }));
                        }
                    }
                }
                Err(e) => {
                    // Connection failed - offer to set bearer token
                    self.agent.remote_servers_mut()[idx].status =
                        ServerConnectionStatus::Error(e.to_string());
                    self.notice(format!(
                        "Connection failed: {}. Enter API key if required.",
                        e
                    ));
                    // Flow to SetToken dialog
                    self.overlay = Some(Overlay::ServerManager(ServerManagerView::SetToken {
                        server_id: server_id.clone(),
                        token_input: String::new(),
                        error: Some(e.to_string()),
                    }));
                }
            }
        }
    }

    fn toggle_server_connection(&mut self, id: &str) {
        ServerManager::toggle_connection(self.agent.remote_servers_mut(), id);
    }

    /// Connect to a remote server by ID (used by both /mcp connect and wizard)
    fn connect_remote_server_by_id(&mut self, id: &str) {
        // Find the server index
        let idx = self
            .agent
            .remote_servers_mut()
            .iter()
            .position(|s| s.id == id);
        if let Some(idx) = idx {
            // Mark as connecting
            self.agent.remote_servers_mut()[idx].status = ServerConnectionStatus::Connecting;

            // Perform actual connection
            let server = &self.agent.remote_servers_mut()[idx];
            match ServerManager::connect_server(server) {
                Ok(tools) => {
                    let tool_count = tools.len();
                    let name = self.agent.remote_servers_mut()[idx].name.clone();
                    self.agent.remote_servers_mut()[idx].status = ServerConnectionStatus::Connected;
                    self.agent.remote_servers_mut()[idx].tools = tools;
                    self.notice(format!(
                        "Connected to '{}'. {} tools available.",
                        name, tool_count
                    ));
                }
                Err(McpError::OAuthRequired(server_url)) => {
                    // OAuth required - trigger OAuth flow
                    self.notice(format!(
                        "Server requires OAuth authentication. Opening authorization popup..."
                    ));

                    // Get redirect URI from origin (browser will provide this via HTTP interception)
                    let redirect_uri = format!(
                        "{}/oauth-callback",
                        std::env::var("ORIGIN")
                            .unwrap_or_else(|_| "https://agent.edge-agent.dev".to_string())
                    );

                    // Use server ID as client ID for now (server may provide real client_id via registration)
                    let client_id = self.agent.remote_servers_mut()[idx].id.clone();
                    let server_id = self.agent.remote_servers_mut()[idx].id.clone();

                    // Perform OAuth flow
                    use crate::bridge::oauth_client::perform_oauth_flow;
                    match perform_oauth_flow(&server_url, &server_id, &client_id, &redirect_uri) {
                        Ok(token_response) => {
                            // Store the token and retry connection
                            self.agent.remote_servers_mut()[idx].bearer_token =
                                Some(token_response.access_token.clone());
                            self.notice("OAuth authorization successful. Connecting...");

                            // Save servers to persist the token
                            self.save_servers();

                            // Retry connection with the new token
                            let server = &self.agent.remote_servers_mut()[idx];
                            match ServerManager::connect_server(server) {
                                Ok(tools) => {
                                    let tool_count = tools.len();
                                    let name = self.agent.remote_servers_mut()[idx].name.clone();
                                    self.agent.remote_servers_mut()[idx].status =
                                        ServerConnectionStatus::Connected;
                                    self.agent.remote_servers_mut()[idx].tools = tools;
                                    self.notice(format!(
                                        "Connected to '{}'. {} tools available.",
                                        name, tool_count
                                    ));
                                }
                                Err(e) => {
                                    self.agent.remote_servers_mut()[idx].status =
                                        ServerConnectionStatus::Error(e.to_string());
                                    self.notice_error(format!(
                                        "Failed to connect after OAuth: {}",
                                        e
                                    ));
                                }
                            }
                        }
                        Err(oauth_err) => {
                            self.agent.remote_servers_mut()[idx].status =
                                ServerConnectionStatus::Error(oauth_err.to_string());
                            self.notice(format!("OAuth failed: {}", oauth_err));
                        }
                    }
                }
                Err(e) => {
                    self.agent.remote_servers_mut()[idx].status =
                        ServerConnectionStatus::Error(e.to_string());
                    self.notice_error(format!("Failed to connect: {}", e));
                }
            }
        }
    }

    /// Auto-connect all predefined MCP servers at startup
    /// Only notifies of errors, does not retry on failure
    fn auto_connect_servers(&mut self) {
        if self.agent.remote_servers_mut().is_empty() {
            return;
        }

        // Collect server IDs first to avoid borrow issues
        let server_ids: Vec<String> = self
            .agent
            .remote_servers_mut()
            .iter()
            .map(|s| s.id.clone())
            .collect();
        let server_count = server_ids.len();

        self.notice(format!(
            "Connecting to {} saved MCP server(s)...",
            server_count
        ));

        let mut connected = 0;
        let mut failed = 0;

        for id in server_ids {
            if let Some(idx) = self
                .agent
                .remote_servers_mut()
                .iter()
                .position(|s| s.id == id)
            {
                self.agent.remote_servers_mut()[idx].status = ServerConnectionStatus::Connecting;
                let server = &self.agent.remote_servers_mut()[idx];

                match ServerManager::connect_server(server) {
                    Ok(tools) => {
                        self.agent.remote_servers_mut()[idx].status =
                            ServerConnectionStatus::Connected;
                        self.agent.remote_servers_mut()[idx].tools = tools;
                        connected += 1;
                    }
                    Err(McpError::OAuthRequired(_)) => {
                        // OAuth required - mark as needing auth, don't auto-trigger popup at startup
                        self.agent.remote_servers_mut()[idx].status = ServerConnectionStatus::Error(
                            "OAuth required - use /mcp connect to authenticate".to_string(),
                        );
                        failed += 1;
                        let server_name = self.agent.remote_servers()[idx].name.clone();
                        self.notice(format!("'{}': OAuth authentication required", server_name));
                    }
                    Err(e) => {
                        self.agent.remote_servers_mut()[idx].status =
                            ServerConnectionStatus::Error(e.to_string());
                        failed += 1;
                        let server_name = self.agent.remote_servers()[idx].name.clone();
                        self.notice(format!("'{}': {}", server_name, e));
                    }
                }
            }
        }

        if connected > 0 || failed > 0 {
            self.notice(format!(
                "MCP servers: {} connected, {} failed",
                connected, failed
            ));
        }
    }

    /// Initialize sandbox MCP connection at startup
    /// This connects to the local sandbox MCP and fetches available tools
    fn init_sandbox_mcp(&mut self) {
        match self.agent.mcp_client().list_tools() {
            Ok(tools) => {
                self.server_status.local_connected = true;
                self.server_status.local_tool_count = tools.len();
                self.notice(format!(
                    "Sandbox MCP connected: {} tools available",
                    tools.len()
                ));
            }
            Err(e) => {
                self.server_status.local_connected = false;
                self.server_status.local_tool_count = 0;
                self.notice(format!("Sandbox MCP connection failed: {}", e));
            }
        }
    }

    /// Save current servers to persistent config
    fn save_servers(&self) {
        use crate::config::ServerEntry;
        let servers_config = ServersConfig {
            servers: self
                .agent
                .remote_servers()
                .iter()
                .map(|s| ServerEntry {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    url: s.url.clone(),
                    api_key: s.bearer_token.clone(),
                    enabled: true,
                })
                .collect(),
        };
        let _ = servers_config.save();
    }

    /// Collect all tools with server prefixes for multi-server routing
    fn collect_all_tools(&mut self) -> Vec<crate::bridge::mcp_client::ToolDefinition> {
        self.agent.collect_all_tools()
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
                self.notice(format!("Completions: {}", options));
            }
        }
    }

    fn handle_slash_command(&mut self, cmd: &str) {
        let parts: Vec<&str> = cmd.trim().split_whitespace().collect();
        let command = parts.first().map(|s| *s).unwrap_or("");

        match command {
            "/help" | "/h" => {
                self.notice(
                    [
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
                );
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
                match self.agent.mcp_client().list_tools() {
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

                self.notice(tool_list.join("\n"));
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

                            for (i, server) in self.agent.remote_servers_mut().iter().enumerate() {
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
                            self.notice(server_list.join("\n"));
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
                                let id =
                                    format!("remote-{}", self.agent.remote_servers_mut().len() + 1);
                                self.agent.remote_servers_mut().push(RemoteServerEntry {
                                    id,
                                    name: name.clone(),
                                    url: url.to_string(),
                                    status: ServerConnectionStatus::Disconnected,
                                    tools: vec![],
                                    bearer_token: None,
                                });
                                let server_count = self.agent.remote_servers().len();
                                self.notice(format!(
                                    "Added MCP server '{}'. Use /mcp connect {} to connect.",
                                    name, server_count
                                ));
                            } else {
                                self.notice("Usage: /mcp add <url> [name]".to_string());
                            }
                        }
                        "remove" => {
                            // Remove server by index: /mcp remove <id>
                            if let Some(id_str) = parts.get(2) {
                                if let Ok(id) = id_str.parse::<usize>() {
                                    if id > 0 && id <= self.agent.remote_servers_mut().len() {
                                        let removed =
                                            self.agent.remote_servers_mut().remove(id - 1);
                                        self.notice(format!(
                                            "Removed MCP server '{}'.",
                                            removed.name
                                        ));
                                    } else {
                                        self.notice(format!(
                                            "Invalid server ID. Use /mcp list to see IDs."
                                        ));
                                    }
                                } else {
                                    self.notice("Usage: /mcp remove <id>".to_string());
                                }
                            } else {
                                self.notice("Usage: /mcp remove <id>".to_string());
                            }
                        }
                        "connect" => {
                            // Connect to server by index: /mcp connect <id>
                            if let Some(id_str) = parts.get(2) {
                                if let Ok(id) = id_str.parse::<usize>() {
                                    if id > 0 && id <= self.agent.remote_servers_mut().len() {
                                        let idx = id - 1;
                                        // Mark as connecting
                                        self.agent.remote_servers_mut()[idx].status =
                                            ServerConnectionStatus::Connecting;
                                        let server_name =
                                            self.agent.remote_servers()[idx].name.clone();
                                        self.notice(format!("Connecting to '{}'...", server_name));

                                        // Perform actual connection
                                        let server = &self.agent.remote_servers_mut()[idx];
                                        match ServerManager::connect_server(server) {
                                            Ok(tools) => {
                                                let tool_count = tools.len();
                                                let name = self.agent.remote_servers_mut()[idx]
                                                    .name
                                                    .clone();
                                                self.agent.remote_servers_mut()[idx].status =
                                                    ServerConnectionStatus::Connected;
                                                self.agent.remote_servers_mut()[idx].tools = tools;
                                                self.notice(format!(
                                                    "Connected to '{}'. {} tools available.",
                                                    name, tool_count
                                                ));
                                            }
                                            Err(e) => {
                                                self.agent.remote_servers_mut()[idx].status =
                                                    ServerConnectionStatus::Error(e.to_string());
                                                self.notice_error(format!(
                                                    "Failed to connect: {}",
                                                    e
                                                ));
                                            }
                                        }
                                    } else {
                                        self.notice("Invalid server ID. Use /mcp list to see IDs.");
                                    }
                                } else {
                                    self.notice("Usage: /mcp connect <id>".to_string());
                                }
                            } else {
                                self.notice("Usage: /mcp connect <id>".to_string());
                            }
                        }
                        "disconnect" => {
                            // Disconnect from server by index: /mcp disconnect <id>
                            if let Some(id_str) = parts.get(2) {
                                if let Ok(id) = id_str.parse::<usize>() {
                                    if id > 0 && id <= self.agent.remote_servers_mut().len() {
                                        let server_name =
                                            self.agent.remote_servers()[id - 1].name.clone();
                                        self.agent.remote_servers_mut()[id - 1].status =
                                            ServerConnectionStatus::Disconnected;
                                        self.agent.remote_servers_mut()[id - 1].tools.clear();
                                        self.notice(format!(
                                            "Disconnected from '{}'.",
                                            server_name
                                        ));
                                    } else {
                                        self.notice("Invalid server ID. Use /mcp list to see IDs.");
                                    }
                                } else {
                                    self.notice("Usage: /mcp disconnect <id>".to_string());
                                }
                            } else {
                                self.notice("Usage: /mcp disconnect <id>".to_string());
                            }
                        }
                        _ => {
                            self.notice(format!(
                                    "Unknown subcommand: {}. Available: list, add, remove, connect, disconnect", 
                                    subcmd
                                ));
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
                // Open model selector overlay (uses ProviderWizard in standalone mode)
                use crate::ui::server_manager::ProviderWizardStep;

                // Find the index of the current provider
                let current_provider = self.agent.config().current_provider().to_string();
                let provider_idx = crate::ui::server_manager::PROVIDERS
                    .iter()
                    .position(|(id, _, _)| *id == current_provider)
                    .unwrap_or(0);

                // Load current settings
                let settings = self.agent.config().providers.get(&current_provider);
                let current_model = settings.model.clone();
                let base_url = settings.base_url.clone().unwrap_or_default();
                let api_key = settings.api_key.clone().unwrap_or_default();

                self.overlay = Some(Overlay::ProviderWizard {
                    step: ProviderWizardStep::EditModel,
                    selected_provider: provider_idx,
                    selected_api_format: 0,
                    selected_model: 0,
                    selected_field: 0,
                    base_url_input: base_url,
                    model_input: current_model,
                    api_key_input: api_key,
                    fetched_models: None,
                    standalone: true,
                });
            }
            "/provider" => {
                // Handle provider subcommands
                if let Some(subcmd) = parts.get(1) {
                    match *subcmd {
                        "status" => {
                            // Show current provider configuration
                            let base_url = self.get_base_url().unwrap_or("(default)");

                            self.notice(format!(
                                "Provider: {}\nModel: {}\nBase URL: {}\nAPI Key: {}",
                                self.provider_name(),
                                self.model_name(),
                                base_url,
                                if self.has_api_key() {
                                    "✓ set"
                                } else {
                                    "✗ not set"
                                }
                            ));
                        }
                        "anthropic" => {
                            // Quick switch to Anthropic
                            self.set_provider("anthropic");
                            self.notice(format!("Switched to Anthropic ({})", self.model_name()));
                        }
                        "openai" => {
                            // Quick switch to OpenAI
                            self.set_provider("openai");
                            self.notice(format!("Switched to OpenAI ({})", self.model_name()));
                        }
                        _ => {
                            self.notice(format!(
                                    "Unknown subcommand: {}. Available: status, anthropic, openai\nOr use /provider with no args for the wizard.",
                                    subcmd
                                ));
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
                    self.notice(
                        "Already in plan mode. Type 'go' to execute or /mode normal to exit.",
                    );
                } else if self.mode == Mode::Shell {
                    self.notice("Exit shell mode first (^D or 'exit').".to_string());
                } else {
                    self.mode = Mode::Plan;
                    self.notice("📋 PLAN MODE - Describe what you want to accomplish.\nType 'go' to execute plan, Ctrl+P to toggle, or /mode normal to exit.".to_string());
                }
            }
            "/mode" => {
                // View or change mode
                if let Some(mode_arg) = parts.get(1) {
                    match *mode_arg {
                        "normal" | "agent" => {
                            self.mode = Mode::Agent;
                            self.notice("Switched to normal mode.".to_string());
                        }
                        "plan" => {
                            self.mode = Mode::Plan;
                            self.notice("📋 Switched to plan mode. Type 'go' to execute or /mode normal to exit.".to_string());
                        }
                        "shell" => {
                            self.notice("Use /shell to enter shell mode.".to_string());
                        }
                        _ => {
                            self.notice(format!(
                                "Unknown mode: {}. Available: normal, plan, shell",
                                mode_arg
                            ));
                        }
                    }
                } else {
                    // Show current mode
                    let mode_str = match self.mode {
                        Mode::Agent => "normal",
                        Mode::Plan => "plan",
                        Mode::Shell => "shell",
                    };
                    self.notice(format!(
                        "Current mode: {}\nUsage: /mode <normal|plan|shell>",
                        mode_str
                    ));
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

                self.notice("Returned from shell".to_string());
            }
            "/key" => {
                self.state = AppState::NeedsApiKey;
                self.notice("Enter API key:".to_string());
            }
            "/config" => {
                // Display current configuration
                let api_key_status = if self.has_api_key() {
                    "configured ✓"
                } else {
                    "not set"
                };

                let theme = self.agent.config().ui.theme.clone();
                let aux_panel = self.agent.config().ui.aux_panel;
                self.notice(format!(
                    "Configuration:\n  Provider: {}\n  Model: {}\n  API Key: {}\n  Theme: {}\n  Aux Panel: {}",
                    self.provider_name(),
                    self.model_name(),
                    api_key_status,
                    theme,
                    if aux_panel { "enabled" } else { "disabled" }
                ));
            }

            "/theme" => {
                // Change theme - usage: /theme dark|light|gruvbox|catppuccin
                if let Some(theme_name) = parts.get(1) {
                    let valid_themes = ["dark", "light", "gruvbox", "catppuccin", "tokyo-night"];
                    if valid_themes.contains(&theme_name.to_lowercase().as_str()) {
                        self.agent.config_mut().ui.theme = theme_name.to_string();
                        let _ = self.agent.config().save();
                        self.notice(format!("Theme changed to: {}", theme_name));
                    } else {
                        self.notice(format!(
                            "Unknown theme: {}. Available: {}",
                            theme_name,
                            valid_themes.join(", ")
                        ));
                    }
                } else {
                    let current_theme = self.agent.config().ui.theme.clone();
                    self.notice(format!(
                            "Current theme: {}. Usage: /theme <name>\nAvailable: dark, light, gruvbox, catppuccin",
                            current_theme
                        ));
                }
            }
            "/clear" => {
                self.agent.clear_messages();
                self.notice("Messages cleared.".to_string());
            }
            "/quit" | "/q" => {
                self.should_quit = true;
            }
            _ => {
                self.notice(format!("Unknown: {}. Try /help", cmd));
            }
        }
    }
}
