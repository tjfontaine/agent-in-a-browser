//! Line Editor - Simple readline-like functionality
//!
//! Handles character-by-character input with basic editing:
//! - Backspace: delete character before cursor
//! - Enter: submit line
//! - Ctrl+C: interrupt (clear line)
//! - Ctrl+D: EOF (on empty line)
//!
//! Future enhancements:
//! - Arrow keys for cursor movement
//! - Up/Down for history
//! - Home/End keys

use crate::bindings::wasi::io::streams::{InputStream, OutputStream};

/// Result of reading a line
pub enum LineResult {
    /// A complete line was read
    Line(String),
    /// EOF was received (Ctrl+D on empty line)
    Eof,
    /// Interrupt was received (Ctrl+C)
    Interrupt,
}

/// Simple line editor
pub struct LineEditor {
    // Future: add history here
}

impl LineEditor {
    pub fn new() -> Self {
        Self {}
    }
    
    /// Read a line from stdin with echo and basic editing
    pub fn read_line(&mut self, stdin: &InputStream, stdout: &OutputStream) -> LineResult {
        let mut buffer = String::new();
        
        loop {
            match read_byte(stdin) {
                Some(b'\r') | Some(b'\n') => {
                    // Enter - submit line
                    write_bytes(stdout, b"\r\n");
                    return LineResult::Line(buffer);
                }
                Some(0x03) => {
                    // Ctrl+C - interrupt
                    return LineResult::Interrupt;
                }
                Some(0x04) => {
                    // Ctrl+D - EOF on empty line, otherwise ignore
                    if buffer.is_empty() {
                        return LineResult::Eof;
                    }
                }
                Some(0x7F) | Some(0x08) => {
                    // Backspace (DEL or BS)
                    if !buffer.is_empty() {
                        buffer.pop();
                        // Erase character on screen: backspace, space, backspace
                        write_bytes(stdout, b"\x08 \x08");
                    }
                }
                Some(0x1B) => {
                    // Escape sequence - read additional bytes
                    if let Some(b'[') = read_byte(stdin) {
                        match read_byte(stdin) {
                            Some(b'A') => {} // Up arrow - TODO: history
                            Some(b'B') => {} // Down arrow - TODO: history
                            Some(b'C') => {} // Right arrow - TODO: cursor
                            Some(b'D') => {} // Left arrow - TODO: cursor
                            Some(b'H') => {} // Home - TODO: cursor
                            Some(b'F') => {} // End - TODO: cursor
                            Some(b'3') => {
                                // Delete key - 3~
                                let _ = read_byte(stdin); // consume ~
                                // TODO: handle delete at cursor
                            }
                            _ => {}
                        }
                    }
                }
                Some(c) if c >= 0x20 && c < 0x7F => {
                    // Printable ASCII
                    buffer.push(c as char);
                    // Echo the character
                    write_bytes(stdout, &[c]);
                }
                Some(_) | None => {
                    // Ignore other characters
                }
            }
        }
    }
}

/// Read a single byte from stdin (blocking)
fn read_byte(stdin: &InputStream) -> Option<u8> {
    match stdin.blocking_read(1) {
        Ok(bytes) if !bytes.is_empty() => Some(bytes[0]),
        _ => None,
    }
}

/// Write bytes to stdout
fn write_bytes(stdout: &OutputStream, data: &[u8]) {
    let _ = stdout.blocking_write_and_flush(data);
}
