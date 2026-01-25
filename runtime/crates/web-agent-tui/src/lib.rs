//! Web Agent TUI - Ratatui-based terminal interface
//!
//! This crate provides the full agent TUI experience using ratatui,
//! running as a WASM component in the browser with ghostty-web.

pub mod agent_core;
pub mod app;
pub mod backend;
pub mod bridge;
pub mod commands;
pub mod config;
pub mod display;
pub mod events;
pub mod input;
pub mod servers;
pub mod ui;

#[allow(warnings)]
mod bindings;

use bindings::Guest;

// Re-export main types
pub use agent_core::{AgentCore, Message, Role, ServerStatus};
pub use app::App;
pub use backend::WasiBackend;
pub use display::{DisplayItem, NoticeKind, TimelineEntry, ToolStatus};
pub use events::{AgentEvent, AgentState};

// Re-export poll API for use in App
pub use bindings::wasi::clocks::monotonic_clock::subscribe_duration;
pub use bindings::wasi::io::poll::{poll, Pollable};

/// Trait for stdin types that support poll-based waiting
pub trait PollableRead: std::io::Read {
    /// Get a pollable that becomes ready when input is available
    fn subscribe(&self) -> Pollable;

    /// Try to read without blocking - returns Ok(0) if no data available
    fn try_read(&self, buf: &mut [u8]) -> std::io::Result<usize>;
}

/// WASI stdin wrapper that implements std::io::Read and poll-based waiting
pub struct WasiStdin {
    stream: bindings::wasi::io::streams::InputStream,
}

impl WasiStdin {
    /// Get a pollable that becomes ready when input is available
    pub fn subscribe(&self) -> bindings::wasi::io::poll::Pollable {
        self.stream.subscribe()
    }

    /// Try to read without blocking - returns Ok(0) if no data available
    pub fn try_read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self.stream.read(buf.len() as u64) {
            Ok(bytes) => {
                let len = bytes.len().min(buf.len());
                buf[..len].copy_from_slice(&bytes[..len]);
                Ok(len)
            }
            Err(bindings::wasi::io::streams::StreamError::Closed) => Ok(0),
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "no data available",
            )),
        }
    }
}

impl std::io::Read for WasiStdin {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self.stream.blocking_read(buf.len() as u64) {
            Ok(bytes) => {
                let len = bytes.len().min(buf.len());
                buf[..len].copy_from_slice(&bytes[..len]);
                Ok(len)
            }
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "read failed",
            )),
        }
    }
}

impl PollableRead for WasiStdin {
    fn subscribe(&self) -> Pollable {
        WasiStdin::subscribe(self)
    }

    fn try_read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
        WasiStdin::try_read(self, buf)
    }
}

/// WASI stdout wrapper that implements std::io::Write
struct WasiStdout {
    stream: bindings::wasi::io::streams::OutputStream,
}

impl std::io::Write for WasiStdout {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self.stream.blocking_write_and_flush(buf) {
            Ok(()) => Ok(buf.len()),
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "write failed",
            )),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct TuiComponent;

impl Guest for TuiComponent {
    fn run() -> i32 {
        // Get WASI stdin/stdout
        let stdin = bindings::wasi::cli::stdin::get_stdin();
        let stdout = bindings::wasi::cli::stdout::get_stdout();

        // Wrap in std::io traits
        let stdin = WasiStdin { stream: stdin };
        let stdout = WasiStdout { stream: stdout };

        // Default terminal size (will be updated by resize events)
        let width = 80u16;
        let height = 24u16;

        // Create and run app
        let mut app = App::new(stdin, stdout, width, height);
        app.run()
    }
}

bindings::__export_world_tui_cabi!(TuiComponent with_types_in bindings);

// =============================================================================
// TEST HARNESS - Mock infrastructure for native testing
// =============================================================================

#[cfg(test)]
pub mod test_harness {
    use std::io::{Cursor, Read, Write};
    use std::sync::{Arc, Mutex};

    /// Mock Pollable for testing (replaces WIT Pollable)
    pub struct MockPollable;

    /// Test-friendly stdin that can be pre-filled with input bytes
    pub struct TestStdin {
        buffer: Arc<Mutex<Cursor<Vec<u8>>>>,
    }

    impl TestStdin {
        /// Create a new TestStdin with the given input bytes
        pub fn new(input: &[u8]) -> Self {
            Self {
                buffer: Arc::new(Mutex::new(Cursor::new(input.to_vec()))),
            }
        }

        /// Push more input bytes (simulates user typing)
        pub fn push(&self, input: &[u8]) {
            let mut buf = self.buffer.lock().unwrap();
            let pos = buf.position();
            let mut data = buf.get_ref().clone();
            data.extend_from_slice(input);
            *buf = Cursor::new(data);
            buf.set_position(pos);
        }
    }

    impl Read for TestStdin {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.buffer.lock().unwrap().read(buf)
        }
    }

    impl super::PollableRead for TestStdin {
        fn subscribe(&self) -> super::Pollable {
            // Return a mock pollable - in tests we don't actually poll
            // This is a workaround since Pollable is a WIT type
            // Tests should use process_input_bytes directly instead of run()
            panic!("subscribe() not supported in tests - use direct method calls")
        }

        fn try_read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.buffer.lock().unwrap().read(buf)
        }
    }

    /// Test-friendly stdout that captures output
    pub struct TestStdout {
        buffer: Arc<Mutex<Vec<u8>>>,
    }

    impl TestStdout {
        pub fn new() -> Self {
            Self {
                buffer: Arc::new(Mutex::new(Vec::new())),
            }
        }

        /// Get captured output as string
        pub fn output(&self) -> String {
            String::from_utf8_lossy(&self.buffer.lock().unwrap()).to_string()
        }

        /// Clear the output buffer
        pub fn clear(&self) {
            self.buffer.lock().unwrap().clear();
        }
    }

    impl Write for TestStdout {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.buffer.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Default for TestStdout {
        fn default() -> Self {
            Self::new()
        }
    }
}
