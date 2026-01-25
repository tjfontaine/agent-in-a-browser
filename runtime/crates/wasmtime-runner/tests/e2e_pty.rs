//! PTY-based E2E tests using expectrl (expect-like library)
//!
//! Uses expectrl for proper interactive TUI testing following Rust best practices.
//! See: https://docs.rs/expectrl/0.8
//!
//! Run: cargo test -p wasmtime-runner --test e2e_pty -- --ignored --test-threads=1
//!
//! ## Test Coverage Notes
//!
//! **Working tests**: Startup and slash command tests work reliably with PTY testing.
//! These tests verify the TUI launches correctly and responds to basic input.
//!
//! **Shell mode limitation**: Shell mode (/sh) uses raw PTY passthrough that
//! doesn't work well with expectrl inspection. For deep shell mode testing,
//! use the browser-based Playwright tests which test the full web runtime.

use std::path::PathBuf;
use std::time::Duration;

use expectrl::{spawn, Expect, Regex};

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

/// Spawn the TUI with expectrl - returns impl Expect trait
fn spawn_tui() -> impl Expect {
    let binary = binary_path();
    if !binary.exists() {
        panic!(
            "Binary not found at {:?}. Run: cargo build --release -p wasmtime-runner",
            binary
        );
    }

    let mut session = spawn(binary.to_str().unwrap()).expect("Failed to spawn TUI");
    session.set_expect_timeout(Some(Duration::from_secs(5)));
    session
}

// =============================================================================
// STARTUP TESTS - Verify binary launches and shows expected initial state
// =============================================================================

#[cfg(test)]
mod startup {
    use super::*;

    #[test]
    #[ignore]
    fn binary_exists() {
        assert!(binary_path().exists(), "Binary should exist");
    }

    #[test]
    #[ignore]
    fn tui_shows_welcome() {
        let mut tui = spawn_tui();
        tui.expect(Regex("Welcome|Agent|Messages"))
            .expect("Should show welcome");
    }

    #[test]
    #[ignore]
    fn tui_shows_prompt() {
        let mut tui = spawn_tui();
        tui.expect("›").expect("Should show prompt");
    }

    #[test]
    #[ignore]
    fn tui_shows_mcp_panel() {
        let mut tui = spawn_tui();
        tui.expect(Regex("MCP|Servers"))
            .expect("Should show MCP panel");
    }
}

// =============================================================================
// SLASH COMMAND TESTS - Verify TUI responds to slash commands
// =============================================================================

#[cfg(test)]
mod slash_commands {
    use super::*;

    #[test]
    #[ignore]
    fn help_shows_commands() {
        let mut tui = spawn_tui();
        tui.expect("›").expect("Wait for prompt");

        tui.send_line("/help").expect("Send /help");
        tui.expect(Regex("Commands|help|clear|config"))
            .expect("Should show help");
    }

    #[test]
    #[ignore]
    fn config_works() {
        let mut tui = spawn_tui();
        tui.expect("›").expect("Wait for prompt");

        tui.send_line("/config").expect("Send /config");
        tui.expect(Regex("Config|config"))
            .expect("Should show config");
    }

    #[test]
    #[ignore]
    fn theme_works() {
        let mut tui = spawn_tui();
        tui.expect("›").expect("Wait for prompt");

        tui.send_line("/theme").expect("Send /theme");
        tui.expect(Regex("theme|Theme")).expect("Should show theme");
    }

    #[test]
    #[ignore]
    fn tools_works() {
        let mut tui = spawn_tui();
        tui.expect("›").expect("Wait for prompt");

        tui.send_line("/tools").expect("Send /tools");
        tui.expect(Regex("Tools|tools|Available"))
            .expect("Should show tools");
    }
}

// =============================================================================
// ERROR HANDLING TESTS - Verify graceful handling of invalid input
// =============================================================================

#[cfg(test)]
mod error_handling {
    use super::*;

    #[test]
    #[ignore]
    fn invalid_command_handled() {
        let mut tui = spawn_tui();
        tui.expect("›").expect("Wait for prompt");

        tui.send_line("notarealcommand12345").expect("Send invalid");
        // Should return to prompt without crashing
        tui.expect("›").expect("Should return to prompt");
    }
}
