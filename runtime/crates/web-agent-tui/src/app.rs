//! Main application state and event loop
//!
//! Manages the TUI lifecycle: init, render, input handling, cleanup.

use ratatui::Terminal;

use crate::backend::{WasiBackend, enter_alternate_screen, leave_alternate_screen};
use crate::bridge::{AiClient, McpClient};
use crate::ui::{Mode, render_ui};
use std::io::{Write, Read};

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
    /// Terminal
    terminal: Terminal<WasiBackend<W>>,
    /// Stdin handle
    stdin: R,
    /// Should quit
    should_quit: bool,
    /// AI client
    ai_client: AiClient,
    /// MCP client
    mcp_client: McpClient,
    /// Pending message to send after API key is set
    pending_message: Option<String>,
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
            messages: vec![
                Message {
                    role: Role::System,
                    content: "Welcome to Agent in a Browser! Type /help for commands.".to_string(),
                }
            ],
            terminal,
            stdin,
            should_quit: false,
            ai_client,
            mcp_client,
            pending_message: None,
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
        
        let _ = self.terminal.draw(|frame| {
            render_ui(frame, mode, state, &input, &messages);
        });
    }
    
    fn handle_input(&mut self) {
        // Read one byte from stdin
        let mut buf = [0u8; 1];
        if self.stdin.read(&mut buf).is_ok() {
            let byte = buf[0];
            match byte {
                // Ctrl+C or Ctrl+D - quit
                0x03 | 0x04 => {
                    self.should_quit = true;
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
    
    fn handle_escape_sequence(&mut self, seq: &[u8]) {
        if seq.len() >= 2 && seq[0] == b'[' {
            match seq[1] {
                b'A' => { /* Up arrow - history */ }
                b'B' => { /* Down arrow - history */ }
                b'C' => { /* Right arrow */ }
                b'D' => { /* Left arrow */ }
                _ => {}
            }
        }
    }
    
    fn submit_input(&mut self) {
        let input = std::mem::take(&mut self.input);
        
        match self.state {
            AppState::NeedsApiKey => {
                // This input is the API key
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
        
        // Get tools from MCP
        let tools = match self.mcp_client.list_tools() {
            Ok(t) => t,
            Err(e) => {
                self.messages.push(Message {
                    role: Role::System,
                    content: format!("MCP error: {}", e),
                });
                // Continue without tools
                vec![]
            }
        };
        
        // Build message history for AI
        let ai_messages: Vec<crate::bridge::ai_client::Message> = self.messages
            .iter()
            .filter_map(|m| match m.role {
                Role::User => Some(crate::bridge::ai_client::Message::user(&m.content)),
                Role::Assistant => Some(crate::bridge::ai_client::Message::assistant(&m.content)),
                Role::System => Some(crate::bridge::ai_client::Message::system(&m.content)),
                Role::Tool => None, // Tool messages need tool_call_id, skip for now
            })
            .collect();
        
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
                    self.messages.push(Message {
                        role: Role::System,
                        content: format!("🔧 Calling tool: {}", tool_call.function.name),
                    });
                    
                    // Parse arguments and call MCP
                    match serde_json::from_str::<serde_json::Value>(&tool_call.function.arguments) {
                        Ok(args) => {
                            match self.mcp_client.call_tool(&tool_call.function.name, args) {
                                Ok(result) => {
                                    self.messages.push(Message {
                                        role: Role::Tool,
                                        content: result,
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
                        Err(e) => {
                            self.messages.push(Message {
                                role: Role::System,
                                content: format!("Invalid tool arguments: {}", e),
                            });
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
                    content: "Commands: /help, /shell, /model, /key, /clear, /quit".to_string(),
                });
            }
            "/shell" | "/sh" => {
                self.mode = Mode::Shell;
                self.messages.push(Message {
                    role: Role::System,
                    content: "Entering shell mode...".to_string(),
                });
            }
            "/key" => {
                // Prompt for new API key
                self.state = AppState::NeedsApiKey;
                self.messages.push(Message {
                    role: Role::System,
                    content: "Enter API key:".to_string(),
                });
            }
            "/clear" => {
                self.messages.clear();
            }
            "/quit" | "/q" => {
                self.should_quit = true;
            }
            _ => {
                self.messages.push(Message {
                    role: Role::System,
                    content: format!("Unknown command: {}", cmd),
                });
            }
        }
    }
}
