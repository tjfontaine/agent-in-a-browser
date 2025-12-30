//! Interactive Shell Module
//!
//! Provides an interactive REPL that uses the existing shell executor.
//! This gives the interactive shell all 50+ commands from shell_eval.

use crate::bindings::exports::shell::unix::command::ExecEnv;
use crate::bindings::wasi::io::streams::{InputStream, OutputStream};
use crate::shell::{run_pipeline, ShellEnv};
use std::fs;
use std::path::PathBuf;

/// Config paths (same as web-agent-tui)
const CONFIG_DIR: &str = ".config/web-agent";
const SHELL_HISTORY_FILE: &str = ".config/web-agent/shell_history";
const MAX_HISTORY_ENTRIES: usize = 1000;

/// Result of reading a line
enum LineResult {
    /// A complete line was read
    Line(String),
    /// EOF was received (Ctrl+D on empty line)
    Eof,
    /// Interrupt was received (Ctrl+C)
    Interrupt,
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

    // Temporarily disabled history load for testing
    let mut history: Vec<String> = Vec::new();
    let mut history_index = 0;

    loop {
        // Render prompt: /current/path$
        let prompt = format!("{}$ ", shell_env.cwd.display());
        write_str(&stdout, &prompt);

        // Read a line with history support
        match read_line(&stdin, &stdout, &mut history, &mut history_index) {
            LineResult::Line(line) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }

                // Add to history (in-memory only for now)
                add_to_history(&mut history, line.to_string());
                history_index = history.len();
                // save_shell_history(&history); // disabled for testing

                // Handle exit command
                if line == "exit" || line.starts_with("exit ") {
                    write_str(&stdout, "Bye!\n");
                    return 0;
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
        }
    }
}

/// Read a line from stdin with echo and readline-style editing
fn read_line(
    stdin: &InputStream,
    stdout: &OutputStream,
    history: &mut Vec<String>,
    history_index: &mut usize,
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
    match fs::read_to_string(SHELL_HISTORY_FILE) {
        Ok(contents) => contents.lines().map(|s| s.to_string()).collect(),
        Err(_) => Vec::new(),
    }
}

fn save_shell_history(history: &[String]) {
    if ensure_config_dir().is_err() {
        return;
    }
    let start = history.len().saturating_sub(MAX_HISTORY_ENTRIES);
    let trimmed = &history[start..];
    let contents = trimmed.join("\n");
    let _ = fs::write(SHELL_HISTORY_FILE, contents);
}

fn ensure_config_dir() -> Result<(), std::io::Error> {
    if let Err(e) = fs::create_dir_all(CONFIG_DIR) {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(e);
        }
    }
    Ok(())
}
