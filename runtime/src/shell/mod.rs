//! Shell module - WASI async shell with bounded pipes
//!
//! Provides a library-OS style shell for executing shell commands
//! with pipe support, exposed as an MCP tool.

mod commands;
mod env;
mod expand;
mod new_executor;
pub mod parser;
pub mod pipeline;

pub use env::ShellEnv;
pub use new_executor::{run_shell, execute_sequence};
pub use parser::{parse_command, ParsedCommand, ParsedRedirect};
pub use pipeline::run_pipeline;

