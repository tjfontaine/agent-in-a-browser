//! Main application state and event loop
//!
//! Manages the TUI lifecycle: init, render, input handling, cleanup.

use ratatui::prelude::*;
use ratatui::Terminal;

use crate::backend::{WasiBackend, enter_alternate_screen, leave_alternate_screen};
use crate::ui::{Mode, render_ui};
use std::io::{Write, Read};

/// Main application state
pub struct App<R: Read, W: Write> {
    /// Current mode
    mode: Mode,
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
        
        Self {
            mode: Mode::Agent,
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
        let input = self.input.clone();
        let messages = self.messages.clone();
        
        let _ = self.terminal.draw(|frame| {
            render_ui(frame, mode, &input, &messages);
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
        
        // Add user message
        self.messages.push(Message {
            role: Role::User,
            content: input.clone(),
        });
        
        // Handle slash commands
        if input.starts_with('/') {
            self.handle_slash_command(&input);
        } else {
            // Regular message - would send to AI
            self.messages.push(Message {
                role: Role::System,
                content: format!("[AI response would go here for: {}]", input),
            });
        }
    }
    
    fn handle_slash_command(&mut self, cmd: &str) {
        match cmd.trim() {
            "/help" | "/h" => {
                self.messages.push(Message {
                    role: Role::System,
                    content: "Commands: /help, /shell, /model, /clear, /quit".to_string(),
                });
            }
            "/shell" | "/sh" => {
                self.mode = Mode::Shell;
                self.messages.push(Message {
                    role: Role::System,
                    content: "Entering shell mode...".to_string(),
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
