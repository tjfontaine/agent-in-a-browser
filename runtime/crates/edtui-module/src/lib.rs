//! edtui-module
//!
//! A vim-inspired text editor using ropey for efficient text handling.
//! Provides vim, vi, and edit commands with:
//! - Undo/redo (u, Ctrl+r)
//! - Visual mode (v, V)
//! - Word motions (w, b, e)
//! - File persistence via WASI filesystem

#[allow(warnings)]
mod bindings;

use bindings::exports::shell::unix::command::{ExecEnv, Guest};
use bindings::terminal::info::size::get_terminal_size;
use bindings::wasi::filesystem::preopens::get_directories;
use bindings::wasi::filesystem::types::{Descriptor, DescriptorFlags, OpenFlags, PathFlags};
use bindings::wasi::io::streams::{InputStream, OutputStream};

use ropey::Rope;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Style, ThemeSet};
use syntect::parsing::SyntaxSet;

struct EdtuiModule;

impl Guest for EdtuiModule {
    fn run(
        name: String,
        args: Vec<String>,
        env: ExecEnv,
        stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) -> i32 {
        match name.as_str() {
            "vim" | "vi" | "edit" => run_editor(args, env, stdin, stdout, stderr),
            _ => {
                write_to_stream(&stderr, format!("Unknown command: {}\n", name).as_bytes());
                127
            }
        }
    }

    fn list_commands() -> Vec<String> {
        vec!["vim".to_string(), "vi".to_string(), "edit".to_string()]
    }
}

// ANSI escape sequences
const CLEAR_SCREEN: &str = "\x1B[2J";
const HOME: &str = "\x1B[H";
const HIDE_CURSOR: &str = "\x1B[?25l";
const SHOW_CURSOR: &str = "\x1B[?25h";
const CLEAR_LINE: &str = "\x1B[K";
const REVERSE_VIDEO: &str = "\x1B[7m";
const RESET: &str = "\x1B[0m";
const YELLOW_BG: &str = "\x1B[43m";
const BLACK_FG: &str = "\x1B[30m";
// Cursor shape sequences (DECSCUSR)
const CURSOR_BLOCK: &str = "\x1B[2 q"; // Steady block
const CURSOR_BAR: &str = "\x1B[6 q"; // Steady bar (vertical line)

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    Normal,
    Insert,
    Command,
    Visual,
    VisualLine,
    Search,
}

/// Undo state snapshot (edtui-inspired pattern)
#[derive(Clone)]
struct UndoState {
    rope: Rope,
    cursor_row: usize,
    cursor_col: usize,
}

struct Editor {
    rope: Rope,
    cursor_row: usize,
    cursor_col: usize,
    mode: Mode,
    command_buffer: String,
    status_message: String,
    modified: bool,
    file_path: Option<String>,
    scroll_offset: usize,
    // Undo/redo stacks (edtui-inspired)
    undo_stack: Vec<UndoState>,
    redo_stack: Vec<UndoState>,
    // Visual mode selection anchor
    selection_anchor: Option<(usize, usize)>,
    // Yank register
    yank_buffer: String,
    yank_is_line: bool,
    // Search state
    search_pattern: String,
    search_matches: Vec<(usize, usize)>, // (row, col) of matches
    current_match_idx: Option<usize>,
}

impl Editor {
    fn new(content: String, file_path: Option<String>) -> Self {
        let rope = if content.is_empty() {
            Rope::from("\n")
        } else {
            Rope::from(content.as_str())
        };

        Self {
            rope,
            cursor_row: 0,
            cursor_col: 0,
            mode: Mode::Normal,
            command_buffer: String::new(),
            status_message: String::new(),
            modified: false,
            file_path,
            scroll_offset: 0,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            selection_anchor: None,
            yank_buffer: String::new(),
            yank_is_line: false,
            search_pattern: String::new(),
            search_matches: Vec::new(),
            current_match_idx: None,
        }
    }

    fn to_string(&self) -> String {
        self.rope.to_string()
    }

    fn line_count(&self) -> usize {
        self.rope.len_lines().max(1)
    }

    fn current_line_len(&self) -> usize {
        if self.cursor_row >= self.line_count() {
            return 0;
        }
        let line = self.rope.line(self.cursor_row);
        let len = line.len_chars();
        // Don't count trailing newline
        if len > 0 && line.char(len - 1) == '\n' {
            len.saturating_sub(1)
        } else {
            len
        }
    }

    fn get_line(&self, row: usize) -> String {
        if row >= self.line_count() {
            return String::new();
        }
        let line = self.rope.line(row);
        let s: String = line.chars().collect();
        s.trim_end_matches('\n').to_string()
    }

    /// Capture current state for undo (edtui pattern)
    fn capture(&mut self) {
        let state = UndoState {
            rope: self.rope.clone(),
            cursor_row: self.cursor_row,
            cursor_col: self.cursor_col,
        };
        self.undo_stack.push(state);
        // Clear redo stack on new change
        self.redo_stack.clear();
        // Limit undo stack size
        if self.undo_stack.len() > 100 {
            self.undo_stack.remove(0);
        }
    }

    fn undo(&mut self) {
        if let Some(prev) = self.undo_stack.pop() {
            // Save current for redo
            let current = UndoState {
                rope: self.rope.clone(),
                cursor_row: self.cursor_row,
                cursor_col: self.cursor_col,
            };
            self.redo_stack.push(current);
            // Restore
            self.rope = prev.rope;
            self.cursor_row = prev.cursor_row;
            self.cursor_col = prev.cursor_col;
            self.clamp_cursor();
            self.status_message = format!("{} changes undone", self.undo_stack.len() + 1);
        } else {
            self.status_message = "Already at oldest change".to_string();
        }
    }

    fn redo(&mut self) {
        if let Some(next) = self.redo_stack.pop() {
            // Save current for undo
            let current = UndoState {
                rope: self.rope.clone(),
                cursor_row: self.cursor_row,
                cursor_col: self.cursor_col,
            };
            self.undo_stack.push(current);
            // Restore
            self.rope = next.rope;
            self.cursor_row = next.cursor_row;
            self.cursor_col = next.cursor_col;
            self.clamp_cursor();
            self.status_message = "Redo".to_string();
        } else {
            self.status_message = "Already at newest change".to_string();
        }
    }

    fn move_up(&mut self) {
        if self.cursor_row > 0 {
            self.cursor_row -= 1;
            self.clamp_cursor_col();
        }
        self.update_selection();
    }

    fn move_down(&mut self) {
        if self.cursor_row < self.line_count().saturating_sub(1) {
            self.cursor_row += 1;
            self.clamp_cursor_col();
        }
        self.update_selection();
    }

    fn move_left(&mut self) {
        if self.cursor_col > 0 {
            self.cursor_col -= 1;
        }
        self.update_selection();
    }

    fn move_right(&mut self) {
        let max_col = if self.mode == Mode::Insert {
            self.current_line_len()
        } else {
            self.current_line_len().saturating_sub(1)
        };
        if self.cursor_col < max_col {
            self.cursor_col += 1;
        }
        self.update_selection();
    }

    fn clamp_cursor(&mut self) {
        let max_row = self.line_count().saturating_sub(1);
        self.cursor_row = self.cursor_row.min(max_row);
        self.clamp_cursor_col();
    }

    fn clamp_cursor_col(&mut self) {
        let max_col = if self.mode == Mode::Insert {
            self.current_line_len()
        } else {
            self.current_line_len().saturating_sub(1).max(0)
        };
        self.cursor_col = self.cursor_col.min(max_col);
    }

    /// Update selection when in visual mode
    fn update_selection(&mut self) {
        if matches!(self.mode, Mode::Visual | Mode::VisualLine) {
            // Selection is tracked via anchor; cursor is the other end
        }
    }

    /// Get selection range (start, end) ordered
    fn get_selection(&self) -> Option<((usize, usize), (usize, usize))> {
        self.selection_anchor.map(|anchor| {
            let cursor = (self.cursor_row, self.cursor_col);
            if anchor <= cursor {
                (anchor, cursor)
            } else {
                (cursor, anchor)
            }
        })
    }

    /// Word motion: is this a word character?
    fn is_word_char(c: char) -> bool {
        c.is_alphanumeric() || c == '_'
    }

    /// Move word forward (w)
    fn move_word_forward(&mut self) {
        let line = self.get_line(self.cursor_row);
        let chars: Vec<char> = line.chars().collect();

        // Skip current word
        while self.cursor_col < chars.len() && Self::is_word_char(chars[self.cursor_col]) {
            self.cursor_col += 1;
        }
        // Skip whitespace
        while self.cursor_col < chars.len() && chars[self.cursor_col].is_whitespace() {
            self.cursor_col += 1;
        }
        // Skip non-word chars
        while self.cursor_col < chars.len()
            && !Self::is_word_char(chars[self.cursor_col])
            && !chars[self.cursor_col].is_whitespace()
        {
            self.cursor_col += 1;
        }

        // If at end of line, move to next line
        if self.cursor_col >= chars.len() && self.cursor_row < self.line_count() - 1 {
            self.cursor_row += 1;
            self.cursor_col = 0;
            // Skip leading whitespace
            let line = self.get_line(self.cursor_row);
            let chars: Vec<char> = line.chars().collect();
            while self.cursor_col < chars.len() && chars[self.cursor_col].is_whitespace() {
                self.cursor_col += 1;
            }
        }
        self.clamp_cursor_col();
        self.update_selection();
    }

    /// Move word backward (b)
    fn move_word_backward(&mut self) {
        if self.cursor_col == 0 {
            if self.cursor_row > 0 {
                self.cursor_row -= 1;
                self.cursor_col = self.current_line_len().saturating_sub(1);
            }
            self.update_selection();
            return;
        }

        let line = self.get_line(self.cursor_row);
        let chars: Vec<char> = line.chars().collect();

        // Move back one
        self.cursor_col = self.cursor_col.saturating_sub(1);

        // Skip whitespace
        while self.cursor_col > 0 && chars[self.cursor_col].is_whitespace() {
            self.cursor_col -= 1;
        }

        // Find start of word
        let is_word = self.cursor_col < chars.len() && Self::is_word_char(chars[self.cursor_col]);
        while self.cursor_col > 0 {
            let prev = chars[self.cursor_col - 1];
            if is_word && !Self::is_word_char(prev) {
                break;
            }
            if !is_word && (Self::is_word_char(prev) || prev.is_whitespace()) {
                break;
            }
            self.cursor_col -= 1;
        }
        self.update_selection();
    }

    /// Move to end of word (e)
    fn move_word_end(&mut self) {
        let line = self.get_line(self.cursor_row);
        let chars: Vec<char> = line.chars().collect();

        if self.cursor_col >= chars.len().saturating_sub(1) {
            if self.cursor_row < self.line_count() - 1 {
                self.cursor_row += 1;
                self.cursor_col = 0;
            }
            self.update_selection();
            return;
        }

        // Move right one
        self.cursor_col += 1;

        // Skip whitespace
        while self.cursor_col < chars.len() && chars[self.cursor_col].is_whitespace() {
            self.cursor_col += 1;
        }

        // Move to end of word
        while self.cursor_col < chars.len() - 1 && Self::is_word_char(chars[self.cursor_col + 1]) {
            self.cursor_col += 1;
        }
        self.clamp_cursor_col();
        self.update_selection();
    }

    fn char_idx(&self, row: usize, col: usize) -> usize {
        if row >= self.line_count() {
            return self.rope.len_chars();
        }
        let line_start = self.rope.line_to_char(row);
        line_start + col
    }

    fn insert_char(&mut self, c: char) {
        self.capture();
        let idx = self.char_idx(self.cursor_row, self.cursor_col);
        self.rope.insert_char(idx, c);
        self.cursor_col += 1;
        self.modified = true;
    }

    fn delete_char_at_cursor(&mut self) {
        if self.cursor_col < self.current_line_len() {
            self.capture();
            let idx = self.char_idx(self.cursor_row, self.cursor_col);
            self.rope.remove(idx..idx + 1);
            self.modified = true;
            self.clamp_cursor_col();
        }
    }

    fn backspace(&mut self) {
        if self.cursor_col > 0 {
            self.capture();
            self.cursor_col -= 1;
            let idx = self.char_idx(self.cursor_row, self.cursor_col);
            self.rope.remove(idx..idx + 1);
            self.modified = true;
        } else if self.cursor_row > 0 {
            self.capture();
            // Join with previous line
            let prev_len = {
                let prev_line = self.rope.line(self.cursor_row - 1);
                let l = prev_line.len_chars();
                if l > 0 && prev_line.char(l - 1) == '\n' {
                    l - 1
                } else {
                    l
                }
            };
            // Remove the newline at end of previous line
            let idx = self.char_idx(self.cursor_row, 0) - 1;
            if idx < self.rope.len_chars() {
                self.rope.remove(idx..idx + 1);
            }
            self.cursor_row -= 1;
            self.cursor_col = prev_len;
            self.modified = true;
        }
    }

    fn insert_newline(&mut self) {
        self.capture();
        let idx = self.char_idx(self.cursor_row, self.cursor_col);
        self.rope.insert_char(idx, '\n');
        self.cursor_row += 1;
        self.cursor_col = 0;
        self.modified = true;
    }

    fn open_line_below(&mut self) {
        self.capture();
        // Insert newline at end of current line
        let line_end = self.char_idx(self.cursor_row, self.current_line_len());
        self.rope.insert_char(line_end, '\n');
        self.cursor_row += 1;
        self.cursor_col = 0;
        self.mode = Mode::Insert;
        self.modified = true;
    }

    fn open_line_above(&mut self) {
        self.capture();
        let line_start = self.char_idx(self.cursor_row, 0);
        self.rope.insert_char(line_start, '\n');
        self.cursor_col = 0;
        self.mode = Mode::Insert;
        self.modified = true;
    }

    fn delete_line(&mut self) {
        self.capture();
        if self.line_count() <= 1 {
            // Clear the only line
            self.rope = Rope::from("\n");
            self.cursor_col = 0;
        } else {
            let start = self.rope.line_to_char(self.cursor_row);
            let end = if self.cursor_row + 1 < self.line_count() {
                self.rope.line_to_char(self.cursor_row + 1)
            } else {
                self.rope.len_chars()
            };
            // Yank before delete
            self.yank_buffer = self.rope.slice(start..end).to_string();
            self.yank_is_line = true;

            self.rope.remove(start..end);
            if self.cursor_row >= self.line_count() {
                self.cursor_row = self.line_count().saturating_sub(1);
            }
            self.clamp_cursor_col();
        }
        self.modified = true;
    }

    fn yank_line(&mut self) {
        let start = self.rope.line_to_char(self.cursor_row);
        let end = if self.cursor_row + 1 < self.line_count() {
            self.rope.line_to_char(self.cursor_row + 1)
        } else {
            self.rope.len_chars()
        };
        self.yank_buffer = self.rope.slice(start..end).to_string();
        self.yank_is_line = true;
        self.status_message = "1 line yanked".to_string();
    }

    fn paste(&mut self) {
        if self.yank_buffer.is_empty() {
            self.status_message = "Nothing to paste".to_string();
            return;
        }
        self.capture();
        if self.yank_is_line {
            // Paste line below
            let end = if self.cursor_row + 1 < self.line_count() {
                self.rope.line_to_char(self.cursor_row + 1)
            } else {
                let len = self.rope.len_chars();
                // Add newline if not present
                if len > 0 && self.rope.char(len - 1) != '\n' {
                    self.rope.insert_char(len, '\n');
                }
                self.rope.len_chars()
            };
            self.rope.insert(end, &self.yank_buffer);
            self.cursor_row += 1;
            self.cursor_col = 0;
        } else {
            // Paste after cursor
            let idx = self.char_idx(self.cursor_row, self.cursor_col + 1);
            self.rope
                .insert(idx.min(self.rope.len_chars()), &self.yank_buffer);
            self.cursor_col += self.yank_buffer.len();
        }
        self.modified = true;
    }

    fn delete_selection(&mut self) {
        if let Some(((start_row, start_col), (end_row, end_col))) = self.get_selection() {
            self.capture();

            if self.mode == Mode::VisualLine {
                // Delete entire lines
                let start = self.rope.line_to_char(start_row);
                let end = if end_row + 1 < self.line_count() {
                    self.rope.line_to_char(end_row + 1)
                } else {
                    self.rope.len_chars()
                };
                self.yank_buffer = self.rope.slice(start..end).to_string();
                self.yank_is_line = true;
                self.rope.remove(start..end);
            } else {
                // Character-wise
                let start = self.char_idx(start_row, start_col);
                let end = self
                    .char_idx(end_row, end_col + 1)
                    .min(self.rope.len_chars());
                self.yank_buffer = self.rope.slice(start..end).to_string();
                self.yank_is_line = false;
                self.rope.remove(start..end);
            }

            self.cursor_row = start_row;
            self.cursor_col = start_col;
            self.clamp_cursor();
            self.modified = true;
            self.selection_anchor = None;
            self.mode = Mode::Normal;

            let lines = self.yank_buffer.matches('\n').count();
            if lines > 0 {
                self.status_message = format!("{} lines deleted", lines + 1);
            }
        }
    }

    fn yank_selection(&mut self) {
        if let Some(((start_row, start_col), (end_row, end_col))) = self.get_selection() {
            if self.mode == Mode::VisualLine {
                let start = self.rope.line_to_char(start_row);
                let end = if end_row + 1 < self.line_count() {
                    self.rope.line_to_char(end_row + 1)
                } else {
                    self.rope.len_chars()
                };
                self.yank_buffer = self.rope.slice(start..end).to_string();
                self.yank_is_line = true;
            } else {
                let start = self.char_idx(start_row, start_col);
                let end = self
                    .char_idx(end_row, end_col + 1)
                    .min(self.rope.len_chars());
                self.yank_buffer = self.rope.slice(start..end).to_string();
                self.yank_is_line = false;
            }

            self.selection_anchor = None;
            self.mode = Mode::Normal;
            self.status_message = "Yanked".to_string();
        }
    }

    fn join_line(&mut self) {
        if self.cursor_row >= self.line_count() - 1 {
            return;
        }
        self.capture();

        // Find end of current line (before newline)
        let line_len = self.current_line_len();
        let newline_idx = self.char_idx(self.cursor_row, line_len);

        if newline_idx < self.rope.len_chars() && self.rope.char(newline_idx) == '\n' {
            self.rope.remove(newline_idx..newline_idx + 1);
            // Add space if needed
            if line_len > 0 {
                self.rope.insert_char(newline_idx, ' ');
            }
            self.cursor_col = line_len;
        }
        self.modified = true;
    }

    fn move_to_line_start(&mut self) {
        self.cursor_col = 0;
        self.update_selection();
    }

    fn move_to_line_end(&mut self) {
        self.cursor_col = self.current_line_len().saturating_sub(1).max(0);
        self.update_selection();
    }

    fn move_to_first_line(&mut self) {
        self.cursor_row = 0;
        self.clamp_cursor_col();
        self.update_selection();
    }

    fn move_to_last_line(&mut self) {
        self.cursor_row = self.line_count().saturating_sub(1);
        self.clamp_cursor_col();
        self.update_selection();
    }

    /// Execute search and find all matches
    fn execute_search(&mut self) {
        self.search_matches.clear();
        self.current_match_idx = None;

        if self.search_pattern.is_empty() {
            return;
        }

        for row in 0..self.line_count() {
            let line = self.get_line(row);
            let mut col = 0;
            while let Some(idx) = line[col..].find(&self.search_pattern) {
                self.search_matches.push((row, col + idx));
                col += idx + self.search_pattern.len();
                if col >= line.len() {
                    break;
                }
            }
        }

        self.status_message = format!("{} match(es)", self.search_matches.len());
    }

    /// Jump to next search match
    fn jump_to_next_match(&mut self) {
        if self.search_matches.is_empty() {
            self.status_message = "Pattern not found".to_string();
            return;
        }

        let current_pos = (self.cursor_row, self.cursor_col);

        // Find first match after current position
        let next_idx = self
            .search_matches
            .iter()
            .position(|&pos| pos > current_pos)
            .unwrap_or(0); // Wrap to beginning

        self.current_match_idx = Some(next_idx);
        let (row, col) = self.search_matches[next_idx];
        self.cursor_row = row;
        self.cursor_col = col;
        self.clamp_cursor();

        self.status_message = format!("{}/{} matches", next_idx + 1, self.search_matches.len());
    }

    /// Jump to previous search match
    fn jump_to_prev_match(&mut self) {
        if self.search_matches.is_empty() {
            self.status_message = "Pattern not found".to_string();
            return;
        }

        let current_pos = (self.cursor_row, self.cursor_col);

        // Find last match before current position
        let prev_idx = self
            .search_matches
            .iter()
            .rposition(|&pos| pos < current_pos)
            .unwrap_or(self.search_matches.len() - 1); // Wrap to end

        self.current_match_idx = Some(prev_idx);
        let (row, col) = self.search_matches[prev_idx];
        self.cursor_row = row;
        self.cursor_col = col;
        self.clamp_cursor();

        self.status_message = format!("{}/{} matches", prev_idx + 1, self.search_matches.len());
    }
}

fn run_editor(
    args: Vec<String>,
    env: ExecEnv,
    stdin: InputStream,
    stdout: OutputStream,
    stderr: OutputStream,
) -> i32 {
    let file_path = args.first().cloned();

    let initial_content = if let Some(ref path) = file_path {
        match read_file(&env.cwd, path) {
            Ok(content) => content,
            Err(e) => {
                if e.contains("not found") || e.contains("no-entry") {
                    String::new()
                } else {
                    write_to_stream(&stderr, format!("Error reading file: {}\n", e).as_bytes());
                    return 1;
                }
            }
        }
    } else {
        String::new()
    };

    let mut editor = Editor::new(initial_content, file_path);
    let mut running = true;
    let mut pending_key: Option<u8> = None; // For multi-key commands (dd, yy, gg)

    write_to_stream(&stdout, CLEAR_SCREEN.as_bytes());
    write_to_stream(&stdout, HOME.as_bytes());

    while running {
        let dims = get_terminal_size();
        draw_editor(&stdout, &editor, dims.cols as usize, dims.rows as usize);

        if let Some(byte) = read_single_byte(&stdin) {
            editor.status_message.clear();

            match editor.mode {
                Mode::Command => handle_command_mode(&mut editor, &mut running, byte, &env.cwd),
                Mode::Insert => handle_insert_mode(&mut editor, byte),
                Mode::Normal => handle_normal_mode(
                    &mut editor,
                    &mut running,
                    &mut pending_key,
                    byte,
                    &stdin,
                    &env.cwd,
                ),
                Mode::Visual | Mode::VisualLine => {
                    handle_visual_mode(&mut editor, &mut pending_key, byte, &stdin)
                }
                Mode::Search => handle_search_mode(&mut editor, byte),
            }
        }
    }

    write_to_stream(&stdout, CLEAR_SCREEN.as_bytes());
    write_to_stream(&stdout, HOME.as_bytes());
    write_to_stream(&stdout, SHOW_CURSOR.as_bytes());

    0
}

fn handle_command_mode(editor: &mut Editor, running: &mut bool, byte: u8, cwd: &str) {
    match byte {
        b'\r' | b'\n' => {
            let cmd = editor.command_buffer.clone();
            let result = execute_command(&cmd, editor, cwd);
            match result {
                CommandResult::Quit => *running = false,
                CommandResult::Saved => {
                    editor.modified = false;
                    editor.status_message = "Saved".to_string();
                }
                CommandResult::SavedAndQuit => {
                    editor.modified = false;
                    *running = false;
                }
                CommandResult::Error(e) => editor.status_message = e,
            }
            editor.command_buffer.clear();
            editor.mode = Mode::Normal;
        }
        0x1B => {
            editor.command_buffer.clear();
            editor.mode = Mode::Normal;
        }
        0x7F | 0x08 => {
            editor.command_buffer.pop();
            if editor.command_buffer.is_empty() {
                editor.mode = Mode::Normal;
            }
        }
        0x20..=0x7E => editor.command_buffer.push(byte as char),
        _ => {}
    }
}

fn handle_insert_mode(editor: &mut Editor, byte: u8) {
    match byte {
        0x1B => {
            editor.mode = Mode::Normal;
            if editor.cursor_col > 0 {
                editor.cursor_col -= 1;
            }
        }
        0x7F | 0x08 => editor.backspace(),
        b'\r' | b'\n' => editor.insert_newline(),
        0x20..=0x7E => editor.insert_char(byte as char),
        _ => {}
    }
}

fn handle_normal_mode(
    editor: &mut Editor,
    _running: &mut bool,
    pending: &mut Option<u8>,
    byte: u8,
    stdin: &InputStream,
    _cwd: &str,
) {
    // Check for pending multi-key commands
    if let Some(prev) = pending.take() {
        match (prev, byte) {
            (b'd', b'd') => editor.delete_line(),
            (b'y', b'y') => editor.yank_line(),
            (b'g', b'g') => editor.move_to_first_line(),
            _ => {} // Unknown combo, ignore
        }
        return;
    }

    match byte {
        b':' => {
            editor.mode = Mode::Command;
            editor.command_buffer.clear();
        }
        // Movement
        b'h' => editor.move_left(),
        b'j' => editor.move_down(),
        b'k' => editor.move_up(),
        b'l' => editor.move_right(),
        b'w' => editor.move_word_forward(),
        b'b' => editor.move_word_backward(),
        b'e' => editor.move_word_end(),
        b'0' => editor.move_to_line_start(),
        b'$' => editor.move_to_line_end(),
        b'G' => editor.move_to_last_line(),
        b'g' | b'd' | b'y' => *pending = Some(byte),
        // Insert modes
        b'i' => editor.mode = Mode::Insert,
        b'a' => {
            editor.cursor_col = (editor.cursor_col + 1).min(editor.current_line_len());
            editor.mode = Mode::Insert;
        }
        b'A' => {
            editor.cursor_col = editor.current_line_len();
            editor.mode = Mode::Insert;
        }
        b'I' => {
            editor.cursor_col = 0;
            editor.mode = Mode::Insert;
        }
        b'o' => editor.open_line_below(),
        b'O' => editor.open_line_above(),
        // Editing
        b'x' => editor.delete_char_at_cursor(),
        b'J' => editor.join_line(),
        b'p' => editor.paste(),
        // Undo/redo
        b'u' => editor.undo(),
        0x12 => editor.redo(), // Ctrl+R
        // Visual mode
        b'v' => {
            editor.mode = Mode::Visual;
            editor.selection_anchor = Some((editor.cursor_row, editor.cursor_col));
        }
        b'V' => {
            editor.mode = Mode::VisualLine;
            editor.selection_anchor = Some((editor.cursor_row, 0));
        }
        // Search mode
        b'/' => {
            editor.mode = Mode::Search;
            editor.search_pattern.clear();
        }
        b'n' => editor.jump_to_next_match(),
        b'N' => editor.jump_to_prev_match(),
        // Arrow keys
        0x1B => {
            if let Some(b'[') = read_single_byte(stdin) {
                match read_single_byte(stdin) {
                    Some(b'A') => editor.move_up(),
                    Some(b'B') => editor.move_down(),
                    Some(b'C') => editor.move_right(),
                    Some(b'D') => editor.move_left(),
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn handle_visual_mode(
    editor: &mut Editor,
    _pending: &mut Option<u8>,
    byte: u8,
    stdin: &InputStream,
) {
    match byte {
        0x1B => {
            editor.mode = Mode::Normal;
            editor.selection_anchor = None;
        }
        // Movement (same as normal)
        b'h' => editor.move_left(),
        b'j' => editor.move_down(),
        b'k' => editor.move_up(),
        b'l' => editor.move_right(),
        b'w' => editor.move_word_forward(),
        b'b' => editor.move_word_backward(),
        b'e' => editor.move_word_end(),
        b'0' => editor.move_to_line_start(),
        b'$' => editor.move_to_line_end(),
        b'G' => editor.move_to_last_line(),
        b'g' => {
            if let Some(b'g') = read_single_byte(stdin) {
                editor.move_to_first_line();
            }
        }
        // Actions on selection
        b'd' | b'x' => editor.delete_selection(),
        b'y' => editor.yank_selection(),
        // Toggle visual line
        b'V' => {
            if editor.mode == Mode::Visual {
                editor.mode = Mode::VisualLine;
            } else {
                editor.mode = Mode::Normal;
                editor.selection_anchor = None;
            }
        }
        b'v' => {
            if editor.mode == Mode::VisualLine {
                editor.mode = Mode::Visual;
            } else {
                editor.mode = Mode::Normal;
                editor.selection_anchor = None;
            }
        }
        _ => {}
    }
}

fn handle_search_mode(editor: &mut Editor, byte: u8) {
    match byte {
        0x1B => {
            // Escape - cancel search
            editor.mode = Mode::Normal;
            editor.search_pattern.clear();
        }
        b'\r' | b'\n' => {
            // Execute search
            if !editor.search_pattern.is_empty() {
                editor.execute_search();
                editor.jump_to_next_match();
            }
            editor.mode = Mode::Normal;
        }
        0x7F | 0x08 => {
            // Backspace
            editor.search_pattern.pop();
            if editor.search_pattern.is_empty() {
                editor.mode = Mode::Normal;
            }
        }
        0x20..=0x7E => {
            // Add character to search pattern
            editor.search_pattern.push(byte as char);
        }
        _ => {}
    }
}

enum CommandResult {
    Quit,
    Saved,
    SavedAndQuit,
    Error(String),
}

fn execute_command(cmd: &str, editor: &mut Editor, cwd: &str) -> CommandResult {
    let cmd = cmd.trim();

    match cmd {
        "q" | "quit" => {
            if editor.modified {
                CommandResult::Error("No write since last change (use :q! to force)".to_string())
            } else {
                CommandResult::Quit
            }
        }
        "q!" | "quit!" => CommandResult::Quit,
        "w" | "write" => {
            if let Some(ref path) = editor.file_path {
                match write_file(cwd, path, &editor.to_string()) {
                    Ok(()) => CommandResult::Saved,
                    Err(e) => CommandResult::Error(format!("Write failed: {}", e)),
                }
            } else {
                CommandResult::Error("No file name".to_string())
            }
        }
        "wq" | "x" => {
            if let Some(ref path) = editor.file_path {
                match write_file(cwd, path, &editor.to_string()) {
                    Ok(()) => CommandResult::SavedAndQuit,
                    Err(e) => CommandResult::Error(format!("Write failed: {}", e)),
                }
            } else {
                CommandResult::Error("No file name".to_string())
            }
        }
        _ => {
            if cmd.starts_with("w ") {
                let new_path = cmd[2..].trim();
                match write_file(cwd, new_path, &editor.to_string()) {
                    Ok(()) => {
                        editor.file_path = Some(new_path.to_string());
                        CommandResult::Saved
                    }
                    Err(e) => CommandResult::Error(format!("Write failed: {}", e)),
                }
            } else {
                CommandResult::Error(format!("Unknown command: {}", cmd))
            }
        }
    }
}

/// Convert a syntect Style to an ANSI escape sequence for foreground color
fn style_to_ansi(style: &Style) -> String {
    let fg = style.foreground;
    format!("\x1B[38;2;{};{};{}m", fg.r, fg.g, fg.b)
}

fn draw_editor(stdout: &OutputStream, editor: &Editor, width: usize, height: usize) {
    let mut buffer = String::new();
    buffer.push_str(HOME);

    let content_height = height.saturating_sub(2);

    // Mode indicator
    let mode_str = match editor.mode {
        Mode::Normal => "NORMAL",
        Mode::Insert => "INSERT",
        Mode::Command => "COMMAND",
        Mode::Visual => "VISUAL",
        Mode::VisualLine => "V-LINE",
        Mode::Search => "SEARCH",
    };
    let filename = editor.file_path.as_deref().unwrap_or("[No Name]");
    let mod_indicator = if editor.modified { "[+]" } else { "" };
    let title = format!(" {} {} {} ", mode_str, filename, mod_indicator);
    buffer.push_str(&format!(
        "{}{:width$}{}\r\n",
        REVERSE_VIDEO,
        title,
        RESET,
        width = width
    ));

    // Get selection for highlighting
    let selection = editor.get_selection();

    // Initialize syntax highlighting
    let ps = SyntaxSet::load_defaults_newlines();
    let ts = ThemeSet::load_defaults();
    let theme = &ts.themes["base16-ocean.dark"];

    // Get syntax by file extension (more reliable than by name)
    let syntax = editor
        .file_path
        .as_deref()
        .and_then(|path| path.rsplit('.').next())
        .and_then(|ext| ps.find_syntax_by_extension(ext))
        .unwrap_or_else(|| ps.find_syntax_plain_text());

    // Create highlighter
    let mut highlighter = HighlightLines::new(syntax, theme);

    // Editor content
    for i in 0..content_height {
        let line_idx = editor.scroll_offset + i;
        if line_idx < editor.line_count() {
            let line = editor.get_line(line_idx);
            let line_with_newline = format!("{}\n", line);
            let mut display = String::new();

            // Get highlighted ranges for this line
            let highlighted = highlighter.highlight_line(&line_with_newline, &ps);

            // Build display string with syntax highlighting and selection
            let mut char_idx = 0;
            if let Ok(ranges) = highlighted {
                for (style, text) in ranges {
                    for c in text.chars() {
                        if c == '\n' {
                            continue; // Skip the newline we added
                        }

                        // Check if this is the cursor position (for block cursor in Normal mode)
                        let is_cursor_pos = line_idx == editor.cursor_row
                            && char_idx == editor.cursor_col
                            && editor.mode != Mode::Insert;

                        let in_selection = if let Some(((sr, sc), (er, ec))) = selection {
                            if editor.mode == Mode::VisualLine {
                                line_idx >= sr && line_idx <= er
                            } else {
                                (line_idx > sr && line_idx < er)
                                    || (line_idx == sr
                                        && line_idx == er
                                        && char_idx >= sc
                                        && char_idx <= ec)
                                    || (line_idx == sr && line_idx < er && char_idx >= sc)
                                    || (line_idx > sr && line_idx == er && char_idx <= ec)
                            }
                        } else {
                            false
                        };

                        if is_cursor_pos {
                            // Block cursor: render with reverse video
                            display.push_str(REVERSE_VIDEO);
                            display.push(c);
                            display.push_str(RESET);
                        } else if in_selection {
                            // Selection overrides syntax highlighting
                            display.push_str(YELLOW_BG);
                            display.push_str(BLACK_FG);
                            display.push(c);
                            display.push_str(RESET);
                        } else {
                            // Apply syntax highlighting color
                            display.push_str(&style_to_ansi(&style));
                            display.push(c);
                            display.push_str(RESET);
                        }
                        char_idx += 1;
                    }
                }
            } else {
                // Fallback: no syntax highlighting (display plain)
                for (col, c) in line.chars().enumerate() {
                    // Check if this is the cursor position
                    let is_cursor_pos = line_idx == editor.cursor_row
                        && col == editor.cursor_col
                        && editor.mode != Mode::Insert;

                    let in_selection = if let Some(((sr, sc), (er, ec))) = selection {
                        if editor.mode == Mode::VisualLine {
                            line_idx >= sr && line_idx <= er
                        } else {
                            (line_idx > sr && line_idx < er)
                                || (line_idx == sr && line_idx == er && col >= sc && col <= ec)
                                || (line_idx == sr && line_idx < er && col >= sc)
                                || (line_idx > sr && line_idx == er && col <= ec)
                        }
                    } else {
                        false
                    };

                    if is_cursor_pos {
                        display.push_str(REVERSE_VIDEO);
                        display.push(c);
                        display.push_str(RESET);
                    } else if in_selection {
                        display.push_str(YELLOW_BG);
                        display.push_str(BLACK_FG);
                        display.push(c);
                        display.push_str(RESET);
                    } else {
                        display.push(c);
                    }
                }
            }

            // Handle cursor at end of line or on empty line (Normal mode block cursor)
            let line_len = line.chars().count();
            if line_idx == editor.cursor_row
                && editor.cursor_col >= line_len
                && editor.mode != Mode::Insert
            {
                display.push_str(REVERSE_VIDEO);
                display.push(' ');
                display.push_str(RESET);
            }

            // Truncate if needed (note: this is imprecise with ANSI codes)
            buffer.push_str(&format!("{}{}\r\n", display, CLEAR_LINE));
        } else {
            buffer.push_str(&format!("~{}\r\n", CLEAR_LINE));
        }
    }

    // Status bar
    if editor.mode == Mode::Command {
        buffer.push_str(&format!(
            "{}:{}{}{}",
            REVERSE_VIDEO, editor.command_buffer, CLEAR_LINE, RESET
        ));
    } else if editor.mode == Mode::Search {
        buffer.push_str(&format!(
            "{}/{}{}{}",
            REVERSE_VIDEO, editor.search_pattern, CLEAR_LINE, RESET
        ));
    } else if !editor.status_message.is_empty() {
        buffer.push_str(&format!(
            "{}{:width$}{}",
            REVERSE_VIDEO,
            editor.status_message,
            RESET,
            width = width
        ));
    } else {
        let pos = format!("{}:{}", editor.cursor_row + 1, editor.cursor_col + 1);
        let padding = " ".repeat(width.saturating_sub(pos.len()));
        buffer.push_str(&format!("{}{}{}{}", REVERSE_VIDEO, padding, pos, RESET));
    }

    // Position cursor
    let screen_row = editor.cursor_row - editor.scroll_offset + 2;
    let screen_col = editor.cursor_col + 1;
    buffer.push_str(&format!("\x1B[{};{}H", screen_row, screen_col));

    // Always show cursor (DECSCUSR shape sequences may not be supported)
    buffer.push_str(SHOW_CURSOR);

    write_to_stream(stdout, buffer.as_bytes());
}

fn read_single_byte(stdin: &InputStream) -> Option<u8> {
    match stdin.blocking_read(1) {
        Ok(bytes) if !bytes.is_empty() => Some(bytes[0]),
        _ => None,
    }
}

fn write_to_stream(stream: &OutputStream, data: &[u8]) {
    let _ = stream.blocking_write_and_flush(data);
}

fn get_root_descriptor() -> Option<Descriptor> {
    let dirs = get_directories();
    dirs.into_iter().next().map(|(desc, _)| desc)
}

fn read_file(cwd: &str, path: &str) -> Result<String, String> {
    let root = get_root_descriptor().ok_or("No filesystem available")?;

    let full_path = if path.starts_with('/') {
        path.trim_start_matches('/').to_string()
    } else {
        let cwd = cwd.trim_start_matches('/');
        if cwd.is_empty() {
            path.to_string()
        } else {
            format!("{}/{}", cwd, path)
        }
    };

    let file = root
        .open_at(
            PathFlags::empty(),
            &full_path,
            OpenFlags::empty(),
            DescriptorFlags::READ,
        )
        .map_err(|e| format!("Failed to open: {:?}", e))?;

    let stat = file
        .stat()
        .map_err(|e| format!("Failed to stat: {:?}", e))?;
    let (content, _) = file
        .read(stat.size, 0)
        .map_err(|e| format!("Failed to read: {:?}", e))?;

    String::from_utf8(content).map_err(|e| format!("Invalid UTF-8: {}", e))
}

fn write_file(cwd: &str, path: &str, content: &str) -> Result<(), String> {
    let root = get_root_descriptor().ok_or("No filesystem available")?;

    let full_path = if path.starts_with('/') {
        path.trim_start_matches('/').to_string()
    } else {
        let cwd = cwd.trim_start_matches('/');
        if cwd.is_empty() {
            path.to_string()
        } else {
            format!("{}/{}", cwd, path)
        }
    };

    let file = root
        .open_at(
            PathFlags::empty(),
            &full_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE,
            DescriptorFlags::WRITE,
        )
        .map_err(|e| format!("Failed to open for write: {:?}", e))?;

    file.write(content.as_bytes(), 0)
        .map_err(|e| format!("Failed to write: {:?}", e))?;

    Ok(())
}

bindings::export!(EdtuiModule with_types_in bindings);
