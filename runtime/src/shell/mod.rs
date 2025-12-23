//! Shell module - WASI async shell with bounded pipes
//!
//! Provides a library-OS style shell for executing shell commands
//! with pipe support, exposed as an MCP tool.

mod commands;
mod env;
mod expand;
mod pipeline;

pub use env::ShellEnv;
pub use pipeline::run_pipeline;

