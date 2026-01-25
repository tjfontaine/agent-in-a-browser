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
        self.cursor_pos += c.len_utf8();
    }

    /// Delete character before cursor (backspace)
    pub fn delete_char_before(&mut self) {
        if self.cursor_pos > 0 {
            // Find the previous char boundary
            let prev_boundary = self.text[..self.cursor_pos]
                .char_indices()
                .map(|(i, _)| i)
                .last()
                .unwrap_or(0);
            let removed_char = self.text.remove(prev_boundary);
            self.cursor_pos = prev_boundary;
            let _ = removed_char; // consume
        }
    }

    /// Move cursor left
    pub fn move_left(&mut self) {
        if self.cursor_pos > 0 {
            // Find the previous char boundary
            self.cursor_pos = self.text[..self.cursor_pos]
                .char_indices()
                .map(|(i, _)| i)
                .last()
                .unwrap_or(0);
        }
    }

    /// Move cursor right
    pub fn move_right(&mut self) {
        if self.cursor_pos < self.text.len() {
            // Find the next char boundary
            if let Some(c) = self.text[self.cursor_pos..].chars().next() {
                self.cursor_pos += c.len_utf8();
            }
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

    // === Control Key Event Injection Tests ===

    #[test]
    fn ctrl_a_moves_to_start() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello world".to_string());
        assert_eq!(buf.cursor_pos(), 11);

        assert!(buf.handle_control(0x01)); // Ctrl+A
        assert_eq!(buf.cursor_pos(), 0);
    }

    #[test]
    fn ctrl_e_moves_to_end() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello world".to_string());
        buf.cursor_pos = 0;

        assert!(buf.handle_control(0x05)); // Ctrl+E
        assert_eq!(buf.cursor_pos(), 11);
    }

    #[test]
    fn ctrl_u_clears_line() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello world".to_string());

        assert!(buf.handle_control(0x15)); // Ctrl+U
        assert_eq!(buf.text(), "");
        assert_eq!(buf.yank_buffer, "hello world");
    }

    #[test]
    fn ctrl_w_deletes_word() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello world".to_string());

        assert!(buf.handle_control(0x17)); // Ctrl+W
        assert_eq!(buf.text(), "hello ");
        assert_eq!(buf.yank_buffer, "world");
    }

    #[test]
    fn ctrl_k_kills_to_end() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello world".to_string());
        buf.cursor_pos = 6;

        assert!(buf.handle_control(0x0B)); // Ctrl+K
        assert_eq!(buf.text(), "hello ");
        assert_eq!(buf.yank_buffer, "world");
    }

    #[test]
    fn ctrl_y_yanks_buffer() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello".to_string());
        buf.yank_buffer = " world".to_string();

        assert!(buf.handle_control(0x19)); // Ctrl+Y
        assert_eq!(buf.text(), "hello world");
    }

    #[test]
    fn backspace_deletes_char() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello".to_string());

        assert!(buf.handle_control(0x7F)); // Backspace
        assert_eq!(buf.text(), "hell");
    }

    #[test]
    fn unhandled_control_returns_false() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello".to_string());

        assert!(!buf.handle_control(0x02)); // Ctrl+B - not handled
        assert_eq!(buf.text(), "hello"); // Unchanged
    }

    #[test]
    fn sequence_of_control_keys() {
        let mut buf = InputBuffer::new();
        buf.set_text("hello world".to_string());

        // Simulate: Ctrl+A (start), then type "say ", then Ctrl+E (end), Ctrl+K (kill)
        buf.handle_control(0x01); // Ctrl+A
        assert_eq!(buf.cursor_pos(), 0);

        // Insert "say "
        for c in "say ".chars() {
            buf.insert_char(c);
        }
        assert_eq!(buf.text(), "say hello world");
        assert_eq!(buf.cursor_pos(), 4);

        buf.handle_control(0x05); // Ctrl+E (end)
        assert_eq!(buf.cursor_pos(), 15);

        buf.handle_control(0x0B); // Ctrl+K (kill to end - no-op at end)
        assert_eq!(buf.text(), "say hello world");
    }

    // === Unicode Edge Cases ===

    #[test]
    fn unicode_emoji_input() {
        let mut buf = InputBuffer::new();
        buf.insert_char('👍');
        buf.insert_char('🎉');

        assert_eq!(buf.text(), "👍🎉");
        assert_eq!(buf.text().chars().count(), 2);
        // cursor_pos is byte position, not char position
        // 👍 = 4 bytes, 🎉 = 4 bytes
        assert_eq!(buf.cursor_pos(), 8);
    }

    #[test]
    fn unicode_mixed_input() {
        let mut buf = InputBuffer::new();
        for c in "hello 世界 🌍".chars() {
            buf.insert_char(c);
        }

        assert_eq!(buf.text(), "hello 世界 🌍");
        // Move cursor back and insert
        buf.move_left(); // Before 🌍
        buf.insert_char('!');
        assert_eq!(buf.text(), "hello 世界 !🌍");
    }

    #[test]
    fn unicode_cursor_navigation() {
        let mut buf = InputBuffer::new();
        buf.set_text("αβγ".to_string()); // 3 Greek characters, each 2 bytes

        buf.move_left(); // Before γ
        buf.move_left(); // Before β
        buf.insert_char('x');

        assert_eq!(buf.text(), "αxβγ");
    }

    #[test]
    fn unicode_backspace() {
        let mut buf = InputBuffer::new();
        buf.set_text("日本語".to_string()); // 3 Japanese characters

        buf.delete_char_before(); // Delete 語
        assert_eq!(buf.text(), "日本");

        buf.delete_char_before(); // Delete 本
        assert_eq!(buf.text(), "日");
    }

    // === Long Line Edge Cases ===

    #[test]
    fn very_long_line() {
        let mut buf = InputBuffer::new();
        let long_text = "x".repeat(10000);
        buf.set_text(long_text.clone());

        assert_eq!(buf.text().len(), 10000);
        assert_eq!(buf.cursor_pos(), 10000);

        // Navigate to start and back
        buf.move_to_start();
        assert_eq!(buf.cursor_pos(), 0);

        buf.move_to_end();
        assert_eq!(buf.cursor_pos(), 10000);
    }

    #[test]
    fn word_deletion_at_line_boundaries() {
        let mut buf = InputBuffer::new();
        buf.set_text("".to_string());

        // Delete word on empty - should be no-op
        buf.delete_word_back();
        assert_eq!(buf.text(), "");

        buf.set_text("single".to_string());
        buf.delete_word_back();
        assert_eq!(buf.text(), "");
    }

    #[test]
    fn clear_and_yank_empty() {
        let mut buf = InputBuffer::new();

        // Kill and yank on empty should be no-ops
        buf.kill_to_end();
        buf.yank();

        assert_eq!(buf.text(), "");
    }
}
