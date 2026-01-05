//! JavaScript module bindings for the QuickJS runtime.
//!
//! This module provides Node.js-compatible APIs for the tsx command.
//! JS shims are embedded as separate .js files for IDE linting support.

pub mod buffer;
pub mod console;
pub mod encoding;
pub mod fetch;
pub mod fs_promises;
pub mod path;
pub mod process;
pub mod url;

// Re-export console log functions for use by the runtime
pub use console::{clear_logs, get_logs};

use rquickjs::{Ctx, Result};

/// Install all JavaScript modules on the global context.
pub fn install_all(ctx: &Ctx<'_>) -> Result<()> {
    console::install(ctx)?;
    process::install(ctx)?; // Install process early so it's available
    path::install(ctx)?;
    fs_promises::install(ctx)?;
    fetch::install(ctx)?;
    encoding::install(ctx)?;
    buffer::install(ctx)?;
    url::install(ctx)?;
    Ok(())
}

#[cfg(test)]
mod tests;
