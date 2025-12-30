//! Line Editor - Readline-like functionality
//!
//! Handles character-by-character input with editing:
//! - Backspace: delete character before cursor
//! - Enter: submit line
//! - Ctrl+C: interrupt (clear line)
//! - Ctrl+D: EOF (on empty line)
//! - Ctrl+A: move cursor to beginning
//! - Ctrl+E: move cursor to end
//! - Ctrl+W: delete word backwards
//! - Ctrl+K: delete from cursor to end
//! - Ctrl+U: clear entire line
//! - Left/Right arrows: move cursor

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

/// Simple line editor with cursor support
pub struct LineEditor {
    // Future: add history here
}

impl LineEditor {
    pub fn new() -> Self {
        Self {}
    }

    /// Read a line from stdin with echo and readline-style editing
    pub fn read_line(&mut self, stdin: &InputStream, stdout: &OutputStream) -> LineResult {
        let mut buffer = String::new();
        let mut cursor_pos: usize = 0;

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
                Some(0x01) => {
                    // Ctrl+A - move to beginning
                    if cursor_pos > 0 {
                        // Move cursor left
                        let move_left = format!("\x1b[{}D", cursor_pos);
                        write_bytes(stdout, move_left.as_bytes());
                        cursor_pos = 0;
                    }
                }
                Some(0x05) => {
                    // Ctrl+E - move to end
                    if cursor_pos < buffer.len() {
                        let move_right = format!("\x1b[{}C", buffer.len() - cursor_pos);
                        write_bytes(stdout, move_right.as_bytes());
                        cursor_pos = buffer.len();
                    }
                }
                Some(0x0B) => {
                    // Ctrl+K - delete from cursor to end
                    if cursor_pos < buffer.len() {
                        buffer.truncate(cursor_pos);
                        // Clear to end of line
                        write_bytes(stdout, b"\x1b[K");
                    }
                }
                Some(0x15) => {
                    // Ctrl+U - clear entire line
                    if !buffer.is_empty() {
                        // Move to beginning, clear to end
                        if cursor_pos > 0 {
                            let move_left = format!("\x1b[{}D", cursor_pos);
                            write_bytes(stdout, move_left.as_bytes());
                        }
                        write_bytes(stdout, b"\x1b[K");
                        buffer.clear();
                        cursor_pos = 0;
                    }
                }
                Some(0x17) => {
                    // Ctrl+W - delete word backwards
                    if cursor_pos > 0 {
                        let original_pos = cursor_pos;
                        // Skip trailing spaces
                        while cursor_pos > 0 && buffer.chars().nth(cursor_pos - 1) == Some(' ') {
                            cursor_pos -= 1;
                        }
                        // Delete until space or start
                        while cursor_pos > 0 && buffer.chars().nth(cursor_pos - 1) != Some(' ') {
                            cursor_pos -= 1;
                        }
                        let deleted_count = original_pos - cursor_pos;
                        // Remove from buffer
                        buffer.drain(cursor_pos..original_pos);
                        // Redraw: move back, print rest of line, clear excess, reposition
                        if deleted_count > 0 {
                            let move_left = format!("\x1b[{}D", deleted_count);
                            write_bytes(stdout, move_left.as_bytes());
                            write_bytes(stdout, buffer[cursor_pos..].as_bytes());
                            write_bytes(stdout, b"\x1b[K");
                            // Move cursor back to position
                            let chars_after = buffer.len() - cursor_pos;
                            if chars_after > 0 {
                                let move_back = format!("\x1b[{}D", chars_after);
                                write_bytes(stdout, move_back.as_bytes());
                            }
                        }
                    }
                }
                Some(0x7F) | Some(0x08) => {
                    // Backspace (DEL or BS)
                    if cursor_pos > 0 {
                        cursor_pos -= 1;
                        buffer.remove(cursor_pos);
                        // Redraw from cursor position
                        write_bytes(stdout, b"\x08"); // move back
                        write_bytes(stdout, buffer[cursor_pos..].as_bytes());
                        write_bytes(stdout, b" \x1b[K"); // clear extra char
                                                         // Move cursor back to position
                        let chars_after = buffer.len() - cursor_pos;
                        if chars_after > 0 {
                            let move_back = format!("\x1b[{}D", chars_after + 1);
                            write_bytes(stdout, move_back.as_bytes());
                        } else {
                            write_bytes(stdout, b"\x08");
                        }
                    }
                }
                Some(0x1B) => {
                    // Escape sequence - read additional bytes
                    if let Some(b'[') = read_byte(stdin) {
                        match read_byte(stdin) {
                            Some(b'A') => {} // Up arrow - TODO: history
                            Some(b'B') => {} // Down arrow - TODO: history
                            Some(b'C') => {
                                // Right arrow - move cursor right
                                if cursor_pos < buffer.len() {
                                    write_bytes(stdout, b"\x1b[C");
                                    cursor_pos += 1;
                                }
                            }
                            Some(b'D') => {
                                // Left arrow - move cursor left
                                if cursor_pos > 0 {
                                    write_bytes(stdout, b"\x1b[D");
                                    cursor_pos -= 1;
                                }
                            }
                            Some(b'H') => {
                                // Home - move to beginning
                                if cursor_pos > 0 {
                                    let move_left = format!("\x1b[{}D", cursor_pos);
                                    write_bytes(stdout, move_left.as_bytes());
                                    cursor_pos = 0;
                                }
                            }
                            Some(b'F') => {
                                // End - move to end
                                if cursor_pos < buffer.len() {
                                    let move_right = format!("\x1b[{}C", buffer.len() - cursor_pos);
                                    write_bytes(stdout, move_right.as_bytes());
                                    cursor_pos = buffer.len();
                                }
                            }
                            Some(b'3') => {
                                // Delete key - 3~
                                let _ = read_byte(stdin); // consume ~
                                if cursor_pos < buffer.len() {
                                    buffer.remove(cursor_pos);
                                    // Redraw from cursor
                                    write_bytes(stdout, buffer[cursor_pos..].as_bytes());
                                    write_bytes(stdout, b" \x1b[K");
                                    let chars_after = buffer.len() - cursor_pos;
                                    if chars_after > 0 {
                                        let move_back = format!("\x1b[{}D", chars_after + 1);
                                        write_bytes(stdout, move_back.as_bytes());
                                    } else {
                                        write_bytes(stdout, b"\x08");
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Some(c) if c >= 0x20 && c < 0x7F => {
                    // Printable ASCII - insert at cursor
                    buffer.insert(cursor_pos, c as char);
                    cursor_pos += 1;
                    // If inserting in middle, redraw rest of line
                    if cursor_pos < buffer.len() {
                        write_bytes(stdout, buffer[cursor_pos - 1..].as_bytes());
                        // Move cursor back to position
                        let chars_after = buffer.len() - cursor_pos;
                        if chars_after > 0 {
                            let move_back = format!("\x1b[{}D", chars_after);
                            write_bytes(stdout, move_back.as_bytes());
                        }
                    } else {
                        // Appending at end - just echo
                        write_bytes(stdout, &[c]);
                    }
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
