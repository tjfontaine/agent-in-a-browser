//! Main application state and event loop
//!
//! Manages the TUI lifecycle: init, render, input handling, cleanup.

use ratatui::Terminal;

use crate::backend::{enter_alternate_screen, leave_alternate_screen, WasiBackend};
use crate::bridge::{
    format_tasks_for_display, get_local_tool_definitions, get_system_message,
    try_execute_local_tool, AiClient, McpClient, Task,
};
use crate::ui::{render_ui, AuxContent, AuxContentKind, Mode, ServerStatus};
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
}

/// Main application state
pub struct App<R: Read, W: Write> {
    /// Current mode
    mode: Mode,
    /// Current state
    state: AppState,
    /// Input buffer for current prompt
    input: String,
    /// Chat/output history  
    messages: Vec<Message>,
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
    /// AI client
    ai_client: AiClient,
    /// MCP client (local sandbox)
    mcp_client: McpClient,
    /// Pending message to send after API key is set
    pending_message: Option<String>,
    /// Auxiliary panel content
    aux_content: AuxContent,
    /// Server connection status
    server_status: ServerStatus,
    /// Current task list (from task_write)
    tasks: Vec<Task>,
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

        // Create AI client (OpenAI by default)
        // TODO: Make this configurable
        let ai_client = AiClient::openai("gpt-4o");

        // Create MCP client pointing to sandbox
        // The URL will be proxied by the frontend to the actual sandbox worker
        let mcp_client = McpClient::new("http://localhost:3000/mcp");

        Self {
            mode: Mode::Agent,
            state: AppState::Ready,
            input: String::new(),
            messages: vec![Message {
                role: Role::System,
                content: "Welcome to Agent in a Browser! Type /help for commands.".to_string(),
            }],
            history: Vec::new(),
            history_index: 0,
            terminal,
            stdin,
            should_quit: false,
            ai_client,
            mcp_client,
            pending_message: None,
            aux_content: AuxContent::default(),
            server_status: ServerStatus {
                local_connected: false, // Will be set after MCP init
                local_tool_count: 0,
                remote_servers: Vec::new(),
            },
            tasks: Vec::new(),
        }
    }

    /// Main run loop
    pub fn run(&mut self) -> i32 {
        // Setup
        self.setup_terminal();

        // Main loop
        while !self.should_quit {
            // Render
            self.render();

            // Handle input
            self.handle_input();
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

    fn render(&mut self) {
        let mode = self.mode;
        let state = self.state;
        let input = self.input.clone();
        let messages = self.messages.clone();
        let aux_content = self.aux_content.clone();
        let server_status = self.server_status.clone();

        let _ = self.terminal.draw(|frame| {
            render_ui(
                frame,
                mode,
                state,
                &input,
                &messages,
                &aux_content,
                &server_status,
            );
        });
    }

    fn handle_input(&mut self) {
        // Read one byte from stdin
        let mut buf = [0u8; 1];
        if self.stdin.read(&mut buf).is_ok() {
            let byte = buf[0];
            match byte {
                // Ctrl+C - quit (always)
                0x03 => {
                    self.should_quit = true;
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
                }
                // Enter - submit
                0x0D | 0x0A => {
                    if !self.input.is_empty() {
                        self.submit_input();
                    }
                }
                // Backspace
                0x7F | 0x08 => {
                    self.input.pop();
                }
                // Ctrl+U - clear input line
                0x15 => {
                    self.input.clear();
                }
                // Tab - potential autocomplete (placeholder)
                0x09 => {
                    // Future: autocomplete
                }
                // Printable ASCII
                0x20..=0x7E => {
                    self.input.push(byte as char);
                }
                // Escape sequence start
                0x1B => {
                    // Read more bytes for escape sequence
                    let mut seq = [0u8; 2];
                    if self.stdin.read(&mut seq).is_ok() {
                        self.handle_escape_sequence(&seq);
                    }
                }
                _ => {}
            }
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

        // Check for extended sequences (like resize: ESC [ 8 ; rows ; cols t)
        if second == b'8' {
            // This might be a resize sequence - read until 't'
            let mut params = vec![b'8'];
            loop {
                let mut buf = [0u8; 1];
                if self.stdin.read(&mut buf).is_err() {
                    break;
                }
                if buf[0] == b't' {
                    // Parse resize: 8;rows;cols
                    let param_str = String::from_utf8_lossy(&params);
                    let parts: Vec<&str> = param_str.split(';').collect();
                    if parts.len() == 3 {
                        if let (Ok(_), Ok(rows), Ok(cols)) = (
                            parts[0].parse::<u16>(),
                            parts[1].parse::<u16>(),
                            parts[2].parse::<u16>(),
                        ) {
                            self.handle_resize(cols, rows);
                        }
                    }
                    return;
                }
                params.push(buf[0]);
                if params.len() > 20 {
                    // Too long, abort
                    break;
                }
            }
            return;
        }

        match second {
            // Up arrow - history previous
            b'A' => {
                if self.history_index > 0 {
                    self.history_index -= 1;
                    if let Some(cmd) = self.history.get(self.history_index) {
                        self.input = cmd.clone();
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
                        self.input = cmd.clone();
                    }
                }
            }
            // Right arrow - move cursor right (placeholder)
            b'C' => {}
            // Left arrow - move cursor left (placeholder)
            b'D' => {}
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
        let input = std::mem::take(&mut self.input);

        match self.state {
            AppState::NeedsApiKey => {
                // This input is the API key - don't add to history
                self.ai_client.set_api_key(&input);
                self.messages.push(Message {
                    role: Role::System,
                    content: "API key set.".to_string(),
                });
                self.state = AppState::Ready;

                // If we have a pending message, send it now
                if let Some(pending) = self.pending_message.take() {
                    self.send_to_ai(&pending);
                }
            }
            AppState::Ready | AppState::Processing => {
                // Add to command history (don't add duplicates)
                if self.history.last() != Some(&input) {
                    self.history.push(input.clone());
                }
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
        if !self.ai_client.has_api_key() {
            // Store the message and prompt for API key
            self.pending_message = Some(message.to_string());
            self.state = AppState::NeedsApiKey;
            self.messages.push(Message {
                role: Role::System,
                content: "Please enter your API key:".to_string(),
            });
            return;
        }

        self.state = AppState::Processing;

        // Get tools from MCP (sandbox)
        let mut tools = match self.mcp_client.list_tools() {
            Ok(t) => {
                // Update server status
                self.server_status.local_connected = true;
                self.server_status.local_tool_count = t.len();
                t
            }
            Err(e) => {
                self.server_status.local_connected = false;
                self.messages.push(Message {
                    role: Role::System,
                    content: format!("MCP error: {}", e),
                });
                // Continue without MCP tools
                vec![]
            }
        };

        // Add local tools (task_write, etc.)
        let local_tools = get_local_tool_definitions();
        tools.extend(local_tools);

        // Build message history for AI with system prompt first
        let mut ai_messages: Vec<crate::bridge::ai_client::Message> = vec![get_system_message()];

        // Add conversation history (skip UI system messages like "Welcome...")
        ai_messages.extend(self.messages.iter().filter_map(|m| match m.role {
            Role::User => Some(crate::bridge::ai_client::Message::user(&m.content)),
            Role::Assistant => Some(crate::bridge::ai_client::Message::assistant(&m.content)),
            // Skip system messages from UI (like "Welcome to...")
            Role::System if m.content.starts_with("Welcome") => None,
            Role::System if m.content.starts_with("Please enter") => None,
            Role::System if m.content.starts_with("API key") => None,
            Role::System if m.content.contains("Calling tool") => None,
            Role::System => Some(crate::bridge::ai_client::Message::system(&m.content)),
            Role::Tool => None, // Tool messages need tool_call_id
        }));

        // Call AI
        match self.ai_client.chat(&ai_messages, &tools) {
            Ok(result) => {
                // Handle text response
                if let Some(text) = result.text {
                    self.messages.push(Message {
                        role: Role::Assistant,
                        content: text,
                    });
                }

                // Handle tool calls
                for tool_call in result.tool_calls {
                    let tool_name = tool_call.function.name.clone();
                    self.messages.push(Message {
                        role: Role::System,
                        content: format!("🔧 Calling tool: {}", tool_name),
                    });

                    // Parse arguments
                    let args = match serde_json::from_str::<serde_json::Value>(
                        &tool_call.function.arguments,
                    ) {
                        Ok(a) => a,
                        Err(e) => {
                            self.messages.push(Message {
                                role: Role::System,
                                content: format!("Invalid tool arguments: {}", e),
                            });
                            continue;
                        }
                    };

                    // Try local tool first
                    if let Some(local_result) = try_execute_local_tool(&tool_name, args.clone()) {
                        // Handle local tool result
                        if local_result.success {
                            // Update tasks if returned
                            if let Some(new_tasks) = local_result.tasks {
                                self.tasks = new_tasks;
                                // Update aux panel with tasks
                                self.aux_content = AuxContent {
                                    kind: AuxContentKind::TaskList,
                                    title: "Tasks".to_string(),
                                    content: format_tasks_for_display(&self.tasks),
                                };
                            }
                            self.messages.push(Message {
                                role: Role::Tool,
                                content: local_result.message,
                            });
                        } else {
                            self.messages.push(Message {
                                role: Role::System,
                                content: format!("Tool error: {}", local_result.message),
                            });
                        }
                    } else {
                        // Delegate to MCP
                        match self.mcp_client.call_tool(&tool_name, args) {
                            Ok(result) => {
                                // Update aux panel with tool output
                                self.aux_content = AuxContent {
                                    kind: AuxContentKind::ToolOutput,
                                    title: tool_name.clone(),
                                    content: result.clone(),
                                };

                                self.messages.push(Message {
                                    role: Role::Tool,
                                    content: if result.len() > 100 {
                                        format!("{}... [see aux panel →]", &result[..100])
                                    } else {
                                        result
                                    },
                                });
                            }
                            Err(e) => {
                                self.messages.push(Message {
                                    role: Role::System,
                                    content: format!("Tool error: {}", e),
                                });
                            }
                        }
                    }
                }
            }
            Err(e) => {
                self.messages.push(Message {
                    role: Role::System,
                    content: format!("AI error: {}", e),
                });
            }
        }

        self.state = AppState::Ready;
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
                        "  /servers  - Show MCP server status",
                        "  /shell    - Enter shell mode (^D to exit)",
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
            "/servers" => {
                let mut status = vec![format!(
                    "MCP Servers:\n  Local sandbox: {} ({} tools)",
                    if self.server_status.local_connected {
                        "●"
                    } else {
                        "○"
                    },
                    self.server_status.local_tool_count
                )];

                if self.server_status.remote_servers.is_empty() {
                    status.push("  Remote: none connected".to_string());
                    status.push("  Use /connect <url> to add".to_string());
                } else {
                    for server in &self.server_status.remote_servers {
                        status.push(format!(
                            "  {} {}: {} ({} tools)",
                            if server.connected { "●" } else { "○" },
                            server.name,
                            server.url,
                            server.tool_count
                        ));
                    }
                }

                self.messages.push(Message {
                    role: Role::System,
                    content: status.join("\n"),
                });
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
