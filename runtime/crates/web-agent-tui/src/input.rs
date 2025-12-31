//! Input handling module
//!
//! Encapsulates text input state and readline-like key handling.

/// Input buffer with cursor position and readline-like editing
#[derive(Default, Clone)]
pub struct InputBuffer {
    /// Current text
    text: String,
    /// Cursor position (0 = start, len = end)
    cursor_pos: usize,
    /// Yank buffer for Ctrl+Y paste
    yank_buffer: String,
}

impl InputBuffer {
    /// Create a new empty input buffer
    pub fn new() -> Self {
        Self::default()
    }

    /// Get current text
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Get cursor position
    pub fn cursor_pos(&self) -> usize {
        self.cursor_pos
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// Set text and move cursor to end
    pub fn set_text(&mut self, text: String) {
        self.cursor_pos = text.len();
        self.text = text;
    }

    /// Clear all text
    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor_pos = 0;
    }

    /// Take the text and clear buffer
    pub fn take(&mut self) -> String {
        self.cursor_pos = 0;
        std::mem::take(&mut self.text)
    }

    /// Insert character at cursor
    pub fn insert_char(&mut self, c: char) {
        self.text.insert(self.cursor_pos, c);
        self.cursor_pos += 1;
    }

    /// Delete character before cursor (backspace)
    pub fn delete_char_before(&mut self) {
        if self.cursor_pos > 0 {
            self.cursor_pos -= 1;
            self.text.remove(self.cursor_pos);
        }
    }

    /// Move cursor left
    pub fn move_left(&mut self) {
        if self.cursor_pos > 0 {
            self.cursor_pos -= 1;
        }
    }

    /// Move cursor right
    pub fn move_right(&mut self) {
        if self.cursor_pos < self.text.len() {
            self.cursor_pos += 1;
        }
    }

    /// Move cursor to start (Ctrl+A)
    pub fn move_to_start(&mut self) {
        self.cursor_pos = 0;
    }

    /// Move cursor to end (Ctrl+E)
    pub fn move_to_end(&mut self) {
        self.cursor_pos = self.text.len();
    }

    /// Delete word backwards (Ctrl+W)
    pub fn delete_word_back(&mut self) {
        if self.cursor_pos > 0 {
            let start = self.cursor_pos;
            // Skip trailing spaces
            while self.cursor_pos > 0 && self.text.chars().nth(self.cursor_pos - 1) == Some(' ') {
                self.cursor_pos -= 1;
            }
            // Delete until space or start
            while self.cursor_pos > 0 && self.text.chars().nth(self.cursor_pos - 1) != Some(' ') {
                self.cursor_pos -= 1;
            }
            // Store in yank buffer and remove
            self.yank_buffer = self.text[self.cursor_pos..start].to_string();
            self.text.replace_range(self.cursor_pos..start, "");
        }
    }

    /// Kill to end of line (Ctrl+K)
    pub fn kill_to_end(&mut self) {
        if self.cursor_pos < self.text.len() {
            self.yank_buffer = self.text[self.cursor_pos..].to_string();
        }
        self.text.truncate(self.cursor_pos);
    }

    /// Clear entire line (Ctrl+U)
    pub fn clear_line(&mut self) {
        self.yank_buffer = self.text.clone();
        self.text.clear();
        self.cursor_pos = 0;
    }

    /// Yank (paste) from buffer (Ctrl+Y)
    pub fn yank(&mut self) {
        if !self.yank_buffer.is_empty() {
            self.text.insert_str(self.cursor_pos, &self.yank_buffer);
            self.cursor_pos += self.yank_buffer.len();
        }
    }

    /// Handle a control character (returns true if handled)
    pub fn handle_control(&mut self, byte: u8) -> bool {
        match byte {
            0x01 => {
                self.move_to_start();
                true
            } // Ctrl+A
            0x05 => {
                self.move_to_end();
                true
            } // Ctrl+E
            0x17 => {
                self.delete_word_back();
                true
            } // Ctrl+W
            0x0B => {
                self.kill_to_end();
                true
            } // Ctrl+K
            0x15 => {
                self.clear_line();
                true
            } // Ctrl+U
            0x19 => {
                self.yank();
                true
            } // Ctrl+Y
            0x7F | 0x08 => {
                self.delete_char_before();
                true
            } // Backspace
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_and_move() {
        let mut buf = InputBuffer::new();
        buf.insert_char('h');
        buf.insert_char('i');
        assert_eq!(buf.text(), "hi");
        assert_eq!(buf.cursor_pos(), 2);

        buf.move_left();
        assert_eq!(buf.cursor_pos(), 1);

        buf.insert_char('!');
        assert_eq!(buf.text(), "h!i");
    }

    #[test]
    fn test_delete_word_back() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello world".to_string());
        buf.delete_word_back();
        assert_eq!(buf.text(), "hello ");
        assert_eq!(buf.yank_buffer, "world");
    }

    #[test]
    fn test_kill_and_yank() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello world".to_string());
        buf.cursor_pos = 6;
        buf.kill_to_end();
        assert_eq!(buf.text(), "hello ");

        buf.yank();
        assert_eq!(buf.text(), "hello world");
    }
}
