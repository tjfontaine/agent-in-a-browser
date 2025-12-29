//! Web Agent TUI - Ratatui-based terminal interface
//!
//! This crate provides the full agent TUI experience using ratatui,
//! running as a WASM component in the browser with ghostty-web.

pub mod app;
pub mod backend;
pub mod ui;
pub mod config;
pub mod bridge;
pub mod commands;

// Re-export main types
pub use app::App;
pub use backend::WasiBackend;
