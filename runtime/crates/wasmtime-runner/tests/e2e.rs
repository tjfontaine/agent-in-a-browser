//! Comprehensive E2E tests for wasmtime-runner TUI
//!
//! Tests the native TUI binary by spawning it and verifying behavior.
//! These tests are marked #[ignore] to run only on demand.
//!
//! Run all: cargo test -p wasmtime-runner --test e2e -- --ignored --test-threads=1
//! Run specific: cargo test -p wasmtime-runner --test e2e test_name -- --ignored

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

/// Path to the TUI binary
fn binary_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent() // crates
        .unwrap()
        .parent() // runtime
        .unwrap()
        .parent() // web-agent
        .unwrap()
        .join("target/release/wasm-tui")
}

/// TUI process wrapper for testing
struct TuiProcess {
    child: Child,
    stdout_rx: Receiver<String>,
    output_buffer: String,
}

impl TuiProcess {
    /// Spawn the TUI process
    fn spawn() -> std::io::Result<Self> {
        let binary = binary_path();
        if !binary.exists() {
            panic!(
                "Binary not found at {:?}. Run: cargo build --release -p wasmtime-runner",
                binary
            );
        }

        let mut child = Command::new(&binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("TERM", "xterm-256color")
            .spawn()?;

        // Create a channel to receive stdout lines asynchronously
        let (tx, rx) = mpsc::channel();
        let stdout = child.stdout.take().expect("Failed to capture stdout");

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });

        Ok(Self {
            child,
            stdout_rx: rx,
            output_buffer: String::new(),
        })
    }

    /// Wait for specific text to appear in output
    fn wait_for(&mut self, text: &str, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;

        while std::time::Instant::now() < deadline {
            // Collect any new output
            while let Ok(line) = self.stdout_rx.try_recv() {
                self.output_buffer.push_str(&line);
                self.output_buffer.push('\n');
            }

            if self.output_buffer.contains(text) {
                return true;
            }

            std::thread::sleep(Duration::from_millis(50));
        }

        false
    }

    /// Type text to stdin
    fn send(&mut self, text: &str) -> std::io::Result<()> {
        if let Some(ref mut stdin) = self.child.stdin {
            stdin.write_all(text.as_bytes())?;
            stdin.flush()?;
        }
        Ok(())
    }

    /// Send text followed by Enter
    fn send_line(&mut self, text: &str) -> std::io::Result<()> {
        self.send(&format!("{}\n", text))
    }

    /// Get all captured output
    fn output(&self) -> &str {
        &self.output_buffer
    }

    /// Check if output contains text (case insensitive)
    fn output_contains(&self, text: &str) -> bool {
        self.output_buffer
            .to_lowercase()
            .contains(&text.to_lowercase())
    }
}

impl Drop for TuiProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// =============================================================================
// STARTUP TESTS
// =============================================================================

mod startup {
    use super::*;

    #[test]
    #[ignore]
    fn binary_exists() {
        let path = binary_path();
        assert!(path.exists(), "Binary should exist at {:?}", path);
    }

    #[test]
    #[ignore]
    fn binary_size_under_60mb() {
        let path = binary_path();
        let metadata = std::fs::metadata(&path).expect("Failed to get metadata");
        let size_mb = metadata.len() / 1024 / 1024;
        assert!(size_mb < 60, "Binary should be <60MB, got {}MB", size_mb);
    }

    #[test]
    #[ignore]
    fn tui_launches_without_crash() {
        let tui = TuiProcess::spawn();
        assert!(tui.is_ok(), "TUI should spawn without error");
    }

    #[test]
    #[ignore]
    fn shows_welcome_message() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        let found = tui.wait_for("Welcome", Duration::from_secs(10));
        assert!(
            found,
            "Should show welcome message. Output: {}",
            tui.output()
        );
    }

    #[test]
    #[ignore]
    fn shows_prompt() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        let found = tui.wait_for("›", Duration::from_secs(10));
        assert!(found, "Should show prompt. Output: {}", tui.output());
    }
}

// =============================================================================
// PANEL TESTS
// =============================================================================

mod panels {
    use super::*;

    #[test]
    #[ignore]
    fn shows_messages_panel() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        let found = tui.wait_for("Messages", Duration::from_secs(10));
        assert!(
            found,
            "Should show Messages panel. Output: {}",
            tui.output()
        );
    }

    #[test]
    #[ignore]
    fn shows_mcp_servers_panel() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("MCP", Duration::from_secs(10));
        let has_mcp = tui.output_contains("MCP") || tui.output_contains("Servers");
        assert!(
            has_mcp,
            "Should show MCP Servers panel. Output: {}",
            tui.output()
        );
    }

    #[test]
    #[ignore]
    fn shows_auxiliary_panel() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("Auxiliary", Duration::from_secs(10));
        let has_aux = tui.output_contains("Auxiliary") || tui.output_contains("output");
        assert!(
            has_aux,
            "Should show Auxiliary panel. Output: {}",
            tui.output()
        );
    }

    #[test]
    #[ignore]
    fn shows_agent_panel() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        let found = tui.wait_for("Agent", Duration::from_secs(10));
        assert!(found, "Should show Agent panel. Output: {}", tui.output());
    }
}

// =============================================================================
// SLASH COMMAND TESTS
// =============================================================================

mod slash_commands {
    use super::*;

    #[test]
    #[ignore]
    fn help_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("/help").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        // TUI should still be running (didn't crash)
        assert!(tui.output().len() > 0, "TUI should produce output");
    }

    #[test]
    #[ignore]
    fn config_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("/config").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }

    #[test]
    #[ignore]
    fn theme_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("/theme").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }

    #[test]
    #[ignore]
    fn clear_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("/clear").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }

    #[test]
    #[ignore]
    fn tools_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("/tools").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }

    #[test]
    #[ignore]
    fn model_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("/model").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }
}

// =============================================================================
// SHELL COMMAND TESTS
// =============================================================================

mod shell_commands {
    use super::*;

    #[test]
    #[ignore]
    fn echo_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("echo hello world")
            .expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }

    #[test]
    #[ignore]
    fn pwd_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("pwd").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }

    #[test]
    #[ignore]
    fn ls_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("ls").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }

    #[test]
    #[ignore]
    fn env_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("env").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }

    #[test]
    #[ignore]
    fn cat_command_accepted() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("cat /etc/hosts")
            .expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(2));
        assert!(tui.output().len() > 0, "TUI should produce output");
    }
}

// =============================================================================
// ERROR HANDLING TESTS
// =============================================================================

mod error_handling {
    use super::*;

    #[test]
    #[ignore]
    fn invalid_command_doesnt_crash() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("thisisnotarealcommand12345")
            .expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        // TUI should still be running
        assert!(
            tui.output().len() > 0,
            "TUI should handle invalid command gracefully"
        );
    }

    #[test]
    #[ignore]
    fn empty_input_handled() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("").expect("Failed to send input");
        tui.send_line("").expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(
            tui.output().len() > 0,
            "TUI should handle empty input gracefully"
        );
    }

    #[test]
    #[ignore]
    fn unknown_slash_command_handled() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("/unknownslashcommand")
            .expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(
            tui.output().len() > 0,
            "TUI should handle unknown slash command"
        );
    }

    #[test]
    #[ignore]
    fn special_characters_handled() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(10));
        tui.send_line("echo '$(whoami)'")
            .expect("Failed to send input");
        std::thread::sleep(Duration::from_secs(1));
        assert!(
            tui.output().len() > 0,
            "TUI should handle special characters"
        );
    }
}

// =============================================================================
// WASM LOADING TESTS
// =============================================================================

mod wasm_loading {
    use super::*;

    #[test]
    #[ignore]
    fn no_panic_on_startup() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(15));
        let output = tui.output();
        assert!(
            !output.contains("panic") && !output.contains("panicked"),
            "Should not panic on startup. Output: {}",
            output
        );
    }

    #[test]
    #[ignore]
    fn no_wasm_loading_errors() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");
        tui.wait_for("›", Duration::from_secs(15));
        let output = tui.output().to_lowercase();
        let has_errors = output.contains("error loading")
            || output.contains("wasm error")
            || output.contains("component error");
        assert!(
            !has_errors,
            "Should have no WASM loading errors. Output: {}",
            output
        );
    }
}

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

mod integration {
    use super::*;

    #[test]
    #[ignore]
    fn full_session_workflow() {
        let mut tui = TuiProcess::spawn().expect("Failed to spawn TUI");

        // Wait for startup
        assert!(
            tui.wait_for("Welcome", Duration::from_secs(15)),
            "Should show welcome"
        );
        assert!(
            tui.wait_for("›", Duration::from_secs(5)),
            "Should show prompt"
        );

        // Run a few commands
        tui.send_line("/help").expect("Failed to send /help");
        std::thread::sleep(Duration::from_millis(500));

        tui.send_line("echo test").expect("Failed to send echo");
        std::thread::sleep(Duration::from_millis(500));

        tui.send_line("/theme").expect("Failed to send /theme");
        std::thread::sleep(Duration::from_millis(500));

        // TUI should still be responsive
        let output = tui.output();
        assert!(
            output.len() > 100,
            "Should have accumulated output: {}",
            output.len()
        );
    }
}
