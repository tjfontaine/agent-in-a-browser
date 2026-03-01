//! JavaScript module bindings for the QuickJS runtime.
//!
//! This module provides Node.js-compatible APIs for the tsx command.
//! JS shims are embedded as separate .js files for IDE linting support.

pub mod assert;
pub mod buffer;
pub mod child_process;
pub mod console;
pub mod crypto;
pub mod encoding;
pub mod events;
pub mod fetch;
pub mod fs_promises;
pub mod http;
pub mod https;
pub mod ios_bridge;
pub mod os;
pub mod path;
pub mod perf_hooks;
pub mod process;
pub mod querystring;
pub mod stream;
pub mod timers;
pub mod url;
pub mod util;

// Re-export console log functions for use by the runtime
#[allow(unused_imports)]
pub use console::{clear_logs, get_logs};

use rquickjs::{Ctx, Result};

/// Install all JavaScript modules on the global context.
pub fn install_all(ctx: &Ctx<'_>) -> Result<()> {
    console::install(ctx)?;
    process::install(ctx)?; // Install process early so it's available (sets up require + builtin registry)
    timers::install(ctx)?; // Install timers after process (depends on timer globals from process.js)
    events::install(ctx)?;
    crypto::install(ctx)?;
    os::install(ctx)?;
    util::install(ctx)?;
    assert::install(ctx)?;
    stream::install(ctx)?;
    path::install(ctx)?;
    fs_promises::install(ctx)?;
    fetch::install(ctx)?;
    encoding::install(ctx)?;
    buffer::install(ctx)?;
    url::install(ctx)?;
    querystring::install(ctx)?;
    child_process::install(ctx)?;
    perf_hooks::install(ctx)?;
    http::install(ctx)?;
    https::install(ctx)?;
    ios_bridge::install(ctx)?;
    Ok(())
}

#[cfg(test)]
mod tests;
