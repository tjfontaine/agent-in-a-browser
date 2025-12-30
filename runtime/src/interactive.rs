//! Interactive Shell Module
//!
//! Provides an interactive REPL that uses the existing shell executor.
//! This gives the interactive shell all 50+ commands from shell_eval.

use crate::bindings::exports::shell::unix::command::ExecEnv;
use crate::bindings::wasi::io::streams::{InputStream, OutputStream};
use crate::shell::{run_pipeline, ShellEnv};
use std::path::PathBuf;

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
    stderr: OutputStream,
) -> i32 {
    // Create shell environment from exec-env
    let mut shell_env = ShellEnv::new();
    shell_env.cwd = PathBuf::from(&env.cwd);

    // Copy environment variables
    for (key, value) in &env.vars {
        let _ = shell_env.set_var(key, value);
    }

    loop {
        // Render prompt: /current/path$
        let prompt = format!("{}$ ", shell_env.cwd.display());
        write_str(&stdout, &prompt);

        // Read a line
        match read_line(&stdin, &stdout) {
            LineResult::Line(line) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }

                // Handle exit command
                if line == "exit" || line.starts_with("exit ") {
                    write_str(&stdout, "Bye!\n");
                    return 0;
                }

                // Check if this is a TUI command that needs direct stdin/stdout
                // Extract command name (first word)
                let cmd_name = line.split_whitespace().next().unwrap_or("");

                // List of TUI commands that need real-time I/O
                const TUI_COMMANDS: &[&str] = &["counter", "ansi-demo", "tui-demo", "ratatui-demo"];

                if TUI_COMMANDS.contains(&cmd_name) {
                    // TUI command - spawn it directly with our stdin/stdout
                    #[cfg(target_arch = "wasm32")]
                    {
                        use crate::bindings::mcp::module_loader::loader;

                        if let Some(module_name) = loader::get_lazy_module(cmd_name) {
                            // Get arguments after command name
                            let args: Vec<String> = line
                                .split_whitespace()
                                .skip(1)
                                .map(|s| s.to_string())
                                .collect();

                            // Build exec environment
                            let exec_env = loader::ExecEnv {
                                cwd: shell_env.cwd.to_string_lossy().to_string(),
                                vars: shell_env
                                    .env_vars
                                    .iter()
                                    .map(|(k, v)| (k.clone(), v.clone()))
                                    .collect(),
                            };

                            // Use spawn_interactive for TUI apps
                            let term_size = loader::TerminalSize { cols: 80, rows: 24 };
                            let process = loader::spawn_interactive(
                                &module_name,
                                cmd_name,
                                &args,
                                &exec_env,
                                term_size,
                            );

                            // Wait for module to load
                            let ready_pollable = process.get_ready_pollable();
                            ready_pollable.block();

                            // Stream I/O until process exits
                            loop {
                                // Check for input from stdin (non-blocking peek)
                                // We can't easily do non-blocking reads with WASI streams,
                                // but the stdin is already in raw mode from the frontend.
                                // The key is forwarding any data we get.

                                // Read stdin and forward to process
                                // Use blocking read since we're waiting for user input
                                let stdin_data = blocking_read(&stdin, 1);
                                if !stdin_data.is_empty() {
                                    process.write_stdin(&stdin_data);
                                }

                                // Read stdout and write to terminal
                                let stdout_data = process.read_stdout(4096);
                                if !stdout_data.is_empty() {
                                    write_bytes(&stdout, &stdout_data);
                                }

                                // Read stderr and write to terminal
                                let stderr_data = process.read_stderr(4096);
                                if !stderr_data.is_empty() {
                                    write_bytes(&stderr, &stderr_data);
                                }

                                // Check if process exited
                                if let Some(_exit_code) = process.try_wait() {
                                    // Drain remaining output
                                    loop {
                                        let chunk = process.read_stdout(4096);
                                        if chunk.is_empty() {
                                            break;
                                        }
                                        write_bytes(&stdout, &chunk);
                                    }
                                    loop {
                                        let chunk = process.read_stderr(4096);
                                        if chunk.is_empty() {
                                            break;
                                        }
                                        write_bytes(&stderr, &chunk);
                                    }
                                    break;
                                }
                            }
                            continue; // Next prompt
                        }
                    }
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
                    write_str(&stderr, &result.stderr);
                    if !result.stderr.ends_with('\n') {
                        write_str(&stderr, "\n");
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

/// Read a line from stdin with echo and basic editing
fn read_line(stdin: &InputStream, stdout: &OutputStream) -> LineResult {
    let mut buffer = String::new();

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

/// Read a single byte from stdin (blocking)
fn read_byte(stdin: &InputStream) -> Option<u8> {
    match stdin.blocking_read(1) {
        Ok(bytes) if !bytes.is_empty() => Some(bytes[0]),
        _ => None,
    }
}

/// Read up to n bytes from stdin (blocking)
fn blocking_read(stdin: &InputStream, n: u64) -> Vec<u8> {
    match stdin.blocking_read(n) {
        Ok(bytes) => bytes,
        Err(_) => Vec::new(),
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
