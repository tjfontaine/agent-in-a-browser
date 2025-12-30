//! Interactive Shell Module
//!
//! Provides an interactive REPL that uses the existing shell executor.
//! This gives the interactive shell all 50+ commands from shell_eval.

use crate::bindings::exports::shell::unix::command::ExecEnv;
use crate::bindings::wasi::io::streams::{InputStream, OutputStream};
use crate::shell::{run_pipeline, ShellEnv};
use std::fs;
use std::path::PathBuf;

/// Config paths (absolute from OPFS root)
const CONFIG_DIR: &str = "/.config/web-agent";
const SHELL_HISTORY_FILE: &str = "/.config/web-agent/shell_history";
const MAX_HISTORY_ENTRIES: usize = 1000;

/// Result of reading a line
enum LineResult {
    /// A complete line was read
    Line(String),
    /// EOF was received (Ctrl+D on empty line)
    Eof,
    /// Interrupt was received (Ctrl+C)
    Interrupt,
    /// Screen was cleared (Ctrl+L), contains any pending input
    ClearScreen(String),
}

/// Main entry point - dispatches to interactive REPL or -c command execution
pub fn run_shell(
    args: Vec<String>,
    env: ExecEnv,
    stdin: InputStream,
    stdout: OutputStream,
    stderr: OutputStream,
) -> i32 {
    // Check for -c flag: sh -c 'command'
    if args.len() >= 2 && args[0] == "-c" {
        // Execute command and return
        let command = &args[1];
        return run_command_string(command, &env, &stdout, &stderr);
    }

    // Otherwise, enter interactive REPL
    run_interactive_shell(env, stdin, stdout, stderr)
}

/// Execute a single command string and return exit code
fn run_command_string(
    command: &str,
    env: &ExecEnv,
    stdout: &OutputStream,
    stderr: &OutputStream,
) -> i32 {
    // Create shell environment
    let mut shell_env = ShellEnv::new();
    shell_env.cwd = PathBuf::from(&env.cwd);

    // Copy environment variables
    for (key, value) in &env.vars {
        let _ = shell_env.set_var(key, value);
    }

    // Execute the command
    let result = futures_lite::future::block_on(run_pipeline(command, &mut shell_env));

    // Output results
    if !result.stdout.is_empty() {
        write_str(stdout, &result.stdout);
        if !result.stdout.ends_with('\n') {
            write_str(stdout, "\n");
        }
    }
    if !result.stderr.is_empty() {
        write_str(stderr, &result.stderr);
        if !result.stderr.ends_with('\n') {
            write_str(stderr, "\n");
        }
    }

    result.code
}

/// Interactive shell REPL
fn run_interactive_shell(
    env: ExecEnv,
    stdin: InputStream,
    stdout: OutputStream,
    _stderr: OutputStream,
) -> i32 {
    // Create shell environment from exec-env
    let mut shell_env = ShellEnv::new();
    shell_env.cwd = PathBuf::from(&env.cwd);

    // Copy environment variables
    for (key, value) in &env.vars {
        let _ = shell_env.set_var(key, value);
    }

    // Load persistent shell history
    let mut history = load_shell_history();
    let mut history_index = history.len();

    loop {
        // Render prompt: /current/path$
        let prompt = format!("{}$ ", shell_env.cwd.display());
        write_str(&stdout, &prompt);

        // Read a line with history support
        match read_line(
            &stdin,
            &stdout,
            &mut history,
            &mut history_index,
            &shell_env.cwd,
        ) {
            LineResult::Line(line) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }

                // Add to history and persist
                add_to_history(&mut history, line.to_string());
                history_index = history.len();
                save_shell_history(&history);

                // Handle exit command
                if line == "exit" || line.starts_with("exit ") {
                    write_str(&stdout, "Bye!\n");
                    return 0;
                }

                // Handle history builtin
                if line == "history" || line.starts_with("history ") {
                    let args: Vec<&str> = line.split_whitespace().collect();
                    if args.len() > 1 && args[1] == "-c" {
                        // Clear history
                        history.clear();
                        history_index = 0;
                        // Delete the history file
                        let _ = fs::remove_file(SHELL_HISTORY_FILE);
                        write_str(&stdout, "History cleared.\n");
                    } else {
                        // List history
                        for (i, entry) in history.iter().enumerate() {
                            write_str(&stdout, &format!("{:5}  {}\n", i + 1, entry));
                        }
                    }
                    continue;
                }

                // Handle clear/reset builtins
                if line == "clear" || line == "reset" {
                    // Clear screen and move cursor to top-left
                    write_bytes(&stdout, b"\x1b[2J\x1b[H");
                    continue;
                }

                // Execute using the full shell executor!
                let result = futures_lite::future::block_on(run_pipeline(line, &mut shell_env));

                // Output result
                if !result.stdout.is_empty() {
                    write_str(&stdout, &result.stdout);
                    if !result.stdout.ends_with('\n') {
                        write_str(&stdout, "\n");
                    }
                }
                if !result.stderr.is_empty() {
                    write_str(&stdout, &result.stderr);
                    if !result.stderr.ends_with('\n') {
                        write_str(&stdout, "\n");
                    }
                }
            }
            LineResult::Eof => {
                // Ctrl+D - exit
                write_str(&stdout, "\nexit\n");
                return 0;
            }
            LineResult::Interrupt => {
                // Ctrl+C - cancel current line, show new prompt
                write_str(&stdout, "^C\n");
            }
            LineResult::ClearScreen(_pending_input) => {
                // Screen was cleared by Ctrl+L, just continue to redraw prompt
                // We don't restore the pending input to keep it simple
            }
        }
    }
}

/// Read a line from stdin with echo and readline-style editing
fn read_line(
    stdin: &InputStream,
    stdout: &OutputStream,
    history: &mut Vec<String>,
    history_index: &mut usize,
    cwd: &std::path::Path,
) -> LineResult {
    let mut buffer = String::new();
    let mut cursor_pos: usize = 0;
    let mut saved_input = String::new(); // Save current input when navigating history

    loop {
        match read_byte(stdin) {
            Some(b'\r') | Some(b'\n') => {
                // Enter - submit line
                write_str(stdout, "\r\n");
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
            Some(0x09) => {
                // Tab - file/path completion
                let (_word_start, partial) = get_current_word(&buffer, cursor_pos);
                let completions = get_path_completions(&partial, cwd);

                if completions.is_empty() {
                    // No completions - do nothing (could beep)
                } else if completions.len() == 1 {
                    // Single match - complete it
                    let completion = &completions[0];
                    let suffix = &completion[partial.len()..];
                    // Insert suffix into buffer
                    buffer.insert_str(cursor_pos, suffix);
                    write_str(stdout, suffix);
                    cursor_pos += suffix.len();
                } else {
                    // Multiple matches - show them and complete common prefix
                    let prefix = common_prefix(&completions);
                    if prefix.len() > partial.len() {
                        // Complete the common part
                        let suffix = &prefix[partial.len()..];
                        buffer.insert_str(cursor_pos, suffix);
                        write_str(stdout, suffix);
                        cursor_pos += suffix.len();
                    } else {
                        // Show all completions
                        write_str(stdout, "\r\n");
                        for c in &completions {
                            write_str(stdout, c);
                            write_str(stdout, "  ");
                        }
                        write_str(stdout, "\r\n");
                        // Redraw prompt and buffer
                        let prompt = format!("{}$ {}", cwd.display(), buffer);
                        write_str(stdout, &prompt);
                        // Position cursor correctly
                        if cursor_pos < buffer.len() {
                            let move_back = format!("\x1b[{}D", buffer.len() - cursor_pos);
                            write_bytes(stdout, move_back.as_bytes());
                        }
                    }
                }
            }
            Some(0x12) => {
                // Ctrl+R - reverse history search
                if let Some(found) = reverse_search(stdin, stdout, history, "") {
                    // Replace buffer with found command
                    buffer = found.clone();
                    cursor_pos = buffer.len();
                    // Redraw with the found command
                    let display = format!("{}$ {}", cwd.display(), buffer);
                    write_str(stdout, &display);
                } else {
                    // Search cancelled, redraw prompt
                    let display = format!("{}$ {}", cwd.display(), buffer);
                    write_str(stdout, &display);
                }
            }
            Some(0x01) => {
                // Ctrl+A - move to beginning
                if cursor_pos > 0 {
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
                    write_bytes(stdout, b"\x1b[K");
                }
            }
            Some(0x15) => {
                // Ctrl+U - clear entire line
                if !buffer.is_empty() {
                    if cursor_pos > 0 {
                        let move_left = format!("\x1b[{}D", cursor_pos);
                        write_bytes(stdout, move_left.as_bytes());
                    }
                    write_bytes(stdout, b"\x1b[K");
                    buffer.clear();
                    cursor_pos = 0;
                }
            }
            Some(0x0C) => {
                // Ctrl+L - clear screen and redraw
                // Clear screen and move to top-left
                write_bytes(stdout, b"\x1b[2J\x1b[H");
                // Return a special result to indicate screen was cleared
                // The caller will redraw the prompt
                return LineResult::ClearScreen(buffer);
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
                    if deleted_count > 0 {
                        buffer.drain(cursor_pos..original_pos);
                        let move_left = format!("\x1b[{}D", deleted_count);
                        write_bytes(stdout, move_left.as_bytes());
                        // Write remaining chars after cursor (if any)
                        let remaining = &buffer[cursor_pos..];
                        if !remaining.is_empty() {
                            write_bytes(stdout, remaining.as_bytes());
                        }
                        write_bytes(stdout, b"\x1b[K");
                        let chars_after = buffer.len().saturating_sub(cursor_pos);
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
                    write_bytes(stdout, b"\x08");
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
            Some(0x1B) => {
                // Escape sequence - read additional bytes
                if let Some(b'[') = read_byte(stdin) {
                    match read_byte(stdin) {
                        Some(b'A') => {
                            // Up arrow - history previous
                            if !history.is_empty() && *history_index > 0 {
                                // Save current input if at end
                                if *history_index == history.len() {
                                    saved_input = buffer.clone();
                                }
                                *history_index -= 1;
                                replace_line(stdout, &buffer, cursor_pos, &history[*history_index]);
                                buffer = history[*history_index].clone();
                                cursor_pos = buffer.len();
                            }
                        }
                        Some(b'B') => {
                            // Down arrow - history next
                            if *history_index < history.len() {
                                *history_index += 1;
                                let new_line = if *history_index >= history.len() {
                                    saved_input.clone()
                                } else {
                                    history[*history_index].clone()
                                };
                                replace_line(stdout, &buffer, cursor_pos, &new_line);
                                buffer = new_line;
                                cursor_pos = buffer.len();
                            }
                        }
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
                if cursor_pos < buffer.len() {
                    write_bytes(stdout, buffer[cursor_pos - 1..].as_bytes());
                    let chars_after = buffer.len() - cursor_pos;
                    if chars_after > 0 {
                        let move_back = format!("\x1b[{}D", chars_after);
                        write_bytes(stdout, move_back.as_bytes());
                    }
                } else {
                    write_bytes(stdout, &[c]);
                }
            }
            Some(_) | None => {
                // Ignore other characters
            }
        }
    }
}

/// Replace the current line on screen with a new one
fn replace_line(stdout: &OutputStream, old: &str, cursor_pos: usize, new: &str) {
    // Build entire output in one buffer to send as single write
    let mut output = String::new();

    // Move to start of line
    if cursor_pos > 0 {
        output.push_str(&format!("\x1b[{}D", cursor_pos));
    }

    // Clear the line
    output.push_str("\x1b[K");

    // Write new content
    output.push_str(new);

    // Send everything as one write
    if !output.is_empty() {
        write_bytes(stdout, output.as_bytes());
    }

    let _ = old; // suppress unused warning
}

/// Read a single byte from stdin (blocking)
fn read_byte(stdin: &InputStream) -> Option<u8> {
    match stdin.blocking_read(1) {
        Ok(bytes) if !bytes.is_empty() => Some(bytes[0]),
        _ => None,
    }
}

/// Write a string to an output stream
/// Converts \n to \r\n for raw terminal mode
fn write_str(stream: &OutputStream, s: &str) {
    // In raw terminal mode, we need \r\n instead of just \n
    let normalized = s.replace("\n", "\r\n");
    let _ = stream.blocking_write_and_flush(normalized.as_bytes());
}

/// Write bytes to an output stream
fn write_bytes(stream: &OutputStream, data: &[u8]) {
    let _ = stream.blocking_write_and_flush(data);
}

/// Add a command to history (handles deduplication)
fn add_to_history(history: &mut Vec<String>, command: String) {
    if command.trim().is_empty() {
        return;
    }
    if history.last().map(|s| s.as_str()) == Some(command.trim()) {
        return;
    }
    history.push(command.trim().to_string());
    if history.len() > MAX_HISTORY_ENTRIES {
        let excess = history.len() - MAX_HISTORY_ENTRIES;
        history.drain(0..excess);
    }
}

// ============================================================================
// History Persistence
// ============================================================================

fn load_shell_history() -> Vec<String> {
    eprintln!("[shell] Loading history from: {}", SHELL_HISTORY_FILE);
    match fs::read_to_string(SHELL_HISTORY_FILE) {
        Ok(contents) => {
            // Filter out empty lines
            let lines: Vec<String> = contents
                .lines()
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .collect();
            eprintln!("[shell] Loaded {} history entries", lines.len());
            lines
        }
        Err(e) => {
            eprintln!("[shell] Failed to load history: {:?}", e);
            Vec::new()
        }
    }
}

fn save_shell_history(history: &[String]) {
    eprintln!(
        "[shell] Saving {} history entries to: {}",
        history.len(),
        SHELL_HISTORY_FILE
    );
    if ensure_config_dir().is_err() {
        eprintln!("[shell] Failed to ensure config dir");
        return;
    }
    let start = history.len().saturating_sub(MAX_HISTORY_ENTRIES);
    let trimmed = &history[start..];
    let contents = trimmed.join("\n");
    match fs::write(SHELL_HISTORY_FILE, &contents) {
        Ok(_) => eprintln!(
            "[shell] History saved successfully ({} bytes)",
            contents.len()
        ),
        Err(e) => eprintln!("[shell] Failed to save history: {:?}", e),
    }
}

fn ensure_config_dir() -> Result<(), std::io::Error> {
    if let Err(e) = fs::create_dir_all(CONFIG_DIR) {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(e);
        }
    }
    Ok(())
}

// ============================================================================
// Tab Completion
// ============================================================================

/// Get completions for a partial path
fn get_path_completions(partial: &str, cwd: &std::path::Path) -> Vec<String> {
    let (dir_path, prefix) = if partial.contains('/') {
        let last_slash = partial.rfind('/').unwrap();
        (&partial[..=last_slash], &partial[last_slash + 1..])
    } else {
        ("", partial)
    };

    // Resolve the directory to search
    let search_dir = if dir_path.is_empty() {
        cwd.to_path_buf()
    } else if dir_path.starts_with('/') {
        PathBuf::from(dir_path)
    } else {
        cwd.join(dir_path)
    };

    let mut completions = Vec::new();

    if let Ok(entries) = fs::read_dir(&search_dir) {
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string() {
                if name.starts_with(prefix) {
                    let mut completion = format!("{}{}", dir_path, name);
                    // Add trailing slash for directories
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        completion.push('/');
                    }
                    completions.push(completion);
                }
            }
        }
    }

    completions.sort();
    completions
}

/// Find the longest common prefix among completions
fn common_prefix(completions: &[String]) -> String {
    if completions.is_empty() {
        return String::new();
    }
    if completions.len() == 1 {
        return completions[0].clone();
    }

    let first = &completions[0];
    let mut prefix_len = first.len();

    for s in &completions[1..] {
        let common = first
            .chars()
            .zip(s.chars())
            .take_while(|(a, b)| a == b)
            .count();
        prefix_len = prefix_len.min(common);
    }

    first[..prefix_len].to_string()
}

/// Extract the word being completed (last space-separated token)
fn get_current_word(buffer: &str, cursor_pos: usize) -> (usize, String) {
    let before_cursor = &buffer[..cursor_pos];
    let word_start = before_cursor.rfind(' ').map(|i| i + 1).unwrap_or(0);
    let word = before_cursor[word_start..].to_string();
    (word_start, word)
}

// ============================================================================
// Reverse History Search (Ctrl+R)
// ============================================================================

/// Perform reverse incremental search through history
fn reverse_search(
    stdin: &InputStream,
    stdout: &OutputStream,
    history: &[String],
    initial_query: &str,
) -> Option<String> {
    let mut query = initial_query.to_string();
    let mut match_idx: Option<usize> = None;

    loop {
        // Find matching history entry (searching backwards)
        match_idx = None;
        if !query.is_empty() {
            for (i, entry) in history.iter().enumerate().rev() {
                if entry.contains(&query) {
                    match_idx = Some(i);
                    break;
                }
            }
        }

        // Display search prompt
        let display = match match_idx {
            Some(idx) => &history[idx],
            None => "",
        };
        let prompt = format!("\r\x1b[K(reverse-i-search)`{}': {}", query, display);
        write_str(stdout, &prompt);

        // Read next key
        match read_byte(stdin) {
            Some(b'\r') | Some(b'\n') => {
                // Accept match
                write_str(stdout, "\r\x1b[K");
                return match_idx.map(|i| history[i].clone());
            }
            Some(0x07) | Some(0x1B) => {
                // Ctrl+G or Escape - cancel
                write_str(stdout, "\r\x1b[K");
                return None;
            }
            Some(0x12) => {
                // Ctrl+R again - find next match
                if !query.is_empty() {
                    if let Some(current) = match_idx {
                        // Search for next match before current
                        for (i, entry) in history[..current].iter().enumerate().rev() {
                            if entry.contains(&query) {
                                match_idx = Some(i);
                                break;
                            }
                        }
                    }
                }
            }
            Some(0x7F) | Some(0x08) => {
                // Backspace - remove last char from query
                query.pop();
            }
            Some(0x03) => {
                // Ctrl+C - cancel
                write_str(stdout, "^C\r\n\x1b[K");
                return None;
            }
            Some(c) if c >= 0x20 && c < 0x7F => {
                // Printable character - add to query
                query.push(c as char);
            }
            _ => {}
        }
    }
}
