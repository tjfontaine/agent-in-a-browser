//! ansi-demo (formerly ratatui-demo)
//!
//! A simple interactive TUI demo using pure ANSI escape codes.
//! Demonstrates interactive terminal I/O with:
//! - Arrow keys: Move cursor
//! - Space: Increment counter
//! - q: Quit
//!
//! This proves the unbuffered input/output pipeline works end-to-end.

#[allow(warnings)]
mod bindings;

use bindings::exports::shell::unix::command::{ExecEnv, Guest};
use bindings::wasi::io::streams::{InputStream, OutputStream};

struct AnsiDemo;

impl Guest for AnsiDemo {
    fn run(
        name: String,
        _args: Vec<String>,
        _env: ExecEnv,
        stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) -> i32 {
        match name.as_str() {
            "ratatui-demo" | "tui-demo" | "counter" | "ansi-demo" => {
                run_counter_demo(stdin, stdout, stderr)
            }
            _ => {
                write_to_stream(&stderr, format!("Unknown command: {}\n", name).as_bytes());
                127
            }
        }
    }

    fn list_commands() -> Vec<String> {
        vec![
            "ratatui-demo".to_string(),
            "tui-demo".to_string(),
            "counter".to_string(),
            "ansi-demo".to_string(),
        ]
    }
}

// ANSI escape sequences
const CSI: &str = "\x1B[";
const CLEAR_SCREEN: &str = "\x1B[2J";
const HOME: &str = "\x1B[H";
const HIDE_CURSOR: &str = "\x1B[?25l";
const SHOW_CURSOR: &str = "\x1B[?25h";

/// Counter demo using pure ANSI escape codes
fn run_counter_demo(stdin: InputStream, stdout: OutputStream, _stderr: OutputStream) -> i32 {
    let mut counter: i32 = 0;
    let mut running = true;

    // Setup: clear screen, hide cursor, move to home position
    write_to_stream(&stdout, CLEAR_SCREEN.as_bytes());
    write_to_stream(&stdout, HOME.as_bytes());
    write_to_stream(&stdout, HIDE_CURSOR.as_bytes());

    // Initial draw
    draw_ui(&stdout, counter);

    while running {
        // Read input (blocking)
        match read_single_byte(&stdin) {
            Some(b' ') => {
                // Space - increment counter
                counter += 1;
                draw_ui(&stdout, counter);
            }
            Some(b'+') | Some(b'=') => {
                counter += 1;
                draw_ui(&stdout, counter);
            }
            Some(b'-') | Some(b'_') => {
                counter -= 1;
                draw_ui(&stdout, counter);
            }
            Some(b'q') | Some(b'Q') => {
                running = false;
            }
            Some(0x03) => {
                // Ctrl+C
                running = false;
            }
            Some(0x04) => {
                // Ctrl+D
                running = false;
            }
            Some(0x1B) => {
                // Escape sequence - check for arrow keys
                if let Some(b'[') = read_single_byte(&stdin) {
                    match read_single_byte(&stdin) {
                        Some(b'A') => {} // Up arrow
                        Some(b'B') => {} // Down arrow
                        Some(b'C') => {
                            // Right - increment
                            counter += 1;
                            draw_ui(&stdout, counter);
                        }
                        Some(b'D') => {
                            // Left - decrement
                            counter -= 1;
                            draw_ui(&stdout, counter);
                        }
                        _ => {}
                    }
                }
            }
            Some(_) | None => {
                // Ignore other keys or timeouts
            }
        }
    }

    // Cleanup: clear screen, show cursor
    write_to_stream(&stdout, CLEAR_SCREEN.as_bytes());
    write_to_stream(&stdout, HOME.as_bytes());
    write_to_stream(&stdout, SHOW_CURSOR.as_bytes());

    // Final message
    let goodbye = format!("Goodbye! Final count: {}\r\n", counter);
    write_to_stream(&stdout, goodbye.as_bytes());

    0
}

/// Draw the TUI interface using ANSI escape codes
fn draw_ui(stdout: &OutputStream, counter: i32) {
    // Move cursor home
    write_to_stream(stdout, HOME.as_bytes());

    // Box drawing characters for nice border
    let box_top = "┌──────────────────────────────────┐";
    let box_mid = "│                                  │";
    let box_bot = "└──────────────────────────────────┘";

    // Colors: cyan title, yellow counter, dim instructions
    let cyan = format!("{}36m", CSI);
    let yellow = format!("{}33m", CSI);
    let dim = format!("{}2m", CSI);
    let reset = format!("{}0m", CSI);
    let bold = format!("{}1m", CSI);

    // Title line
    write_to_stream(
        stdout,
        format!(
            "{}{}🦀 ANSI Demo - Interactive Counter{}\r\n",
            bold, cyan, reset
        )
        .as_bytes(),
    );
    write_to_stream(stdout, "\r\n".as_bytes());

    // Box with counter
    write_to_stream(stdout, format!("{}\r\n", box_top).as_bytes());
    write_to_stream(
        stdout,
        format!(
            "{}  {}{}Counter: {:>10}{}{}\r\n",
            box_mid.chars().next().unwrap(),
            bold,
            yellow,
            counter,
            reset,
            &box_mid[box_mid.len() - 3..] // Right border
        )
        .as_bytes(),
    );
    write_to_stream(stdout, format!("{}\r\n", box_mid).as_bytes());
    write_to_stream(stdout, format!("{}\r\n", box_bot).as_bytes());

    // Instructions
    write_to_stream(stdout, "\r\n".as_bytes());
    write_to_stream(stdout, format!("{}Controls:{}\r\n", dim, reset).as_bytes());
    write_to_stream(
        stdout,
        format!("{}  SPACE or + : Increment{}\r\n", dim, reset).as_bytes(),
    );
    write_to_stream(
        stdout,
        format!("{}  - or ←/→  : Decrement/Increment{}\r\n", dim, reset).as_bytes(),
    );
    write_to_stream(
        stdout,
        format!("{}  q         : Quit{}\r\n", dim, reset).as_bytes(),
    );
}

/// Read a single byte from stdin (blocking)
fn read_single_byte(stdin: &InputStream) -> Option<u8> {
    match stdin.blocking_read(1) {
        Ok(bytes) if !bytes.is_empty() => Some(bytes[0]),
        _ => None,
    }
}

/// Helper to write data to an output stream
fn write_to_stream(stream: &OutputStream, data: &[u8]) {
    let _ = stream.blocking_write_and_flush(data);
}

bindings::export!(AnsiDemo with_types_in bindings);
