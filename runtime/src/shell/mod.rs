//! Shell module - WASI async shell with bounded pipes
//!
//! Provides a library-OS style shell for executing shell commands
//! with pipe support, exposed as an MCP tool.

mod commands;
mod env;
mod expand;
pub mod parser;
mod pipeline;

pub use env::ShellEnv;
pub use parser::{parse_command, ParsedCommand, ParsedRedirect};
pub use pipeline::run_pipeline;

