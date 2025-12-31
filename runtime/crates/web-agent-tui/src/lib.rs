//! Web Agent TUI - Ratatui-based terminal interface
//!
//! This crate provides the full agent TUI experience using ratatui,
//! running as a WASM component in the browser with ghostty-web.

pub mod app;
pub mod backend;
pub mod bridge;
pub mod commands;
pub mod config;
pub mod servers;
pub mod ui;

#[allow(warnings)]
mod bindings;

use bindings::Guest;

// Re-export main types
pub use app::App;
pub use backend::WasiBackend;

/// WASI stdin wrapper that implements std::io::Read
struct WasiStdin {
    stream: bindings::wasi::io::streams::InputStream,
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
