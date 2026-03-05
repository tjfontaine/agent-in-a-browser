//! JavaScript module bindings for the QuickJS runtime.
//!
//! This module provides Node.js-compatible APIs for the tsx command.
//! JS shims are embedded as separate .js files for IDE linting support.

pub mod assert;
pub mod buffer;
pub mod child_process;
pub mod cluster;
pub mod console;
pub mod crypto;
// NOTE: `utils` is not listed alphabetically because it must be installed first.
// See install_all() for ordering rationale.
pub mod dgram;
pub mod dns;
pub mod domain;
pub mod encoding;
pub mod events;
pub mod fetch;
pub mod fs_promises;
pub mod http;
pub mod https;
pub mod ios_bridge;
#[path = "module_mod.rs"]
pub mod module_mod;
pub mod net;
pub mod os;
pub mod path;
pub mod perf_hooks;
pub mod process;
pub mod punycode;
pub mod querystring;
pub mod readline;
pub mod stream;
pub mod string_decoder;
pub mod timers;
pub mod tls;
pub mod tty;
pub mod url;
pub mod util;
pub mod utils;
pub mod v8;
pub mod vm;
pub mod worker_threads;
pub mod zlib;

// Re-export console log functions for use by the runtime
#[allow(unused_imports)]
pub use console::{clear_logs, get_logs};

use rquickjs::{Ctx, Result};

/// Install all JavaScript modules on the global context.
///
/// ## Bridge conventions
///
/// Rust bridges expose globals that JS shims can call for correctness-critical operations:
///
/// - **Latin1 strings** (preferred for binary data): `utils.rs`, `crypto.rs` — each JS char
///   represents one byte (code points 0–255). Use for encoding, hashing, HMAC.
/// - **JSON strings** (for structured returns): `child_process.rs`, `fetch.rs` — multiple
///   fields serialized as JSON, parsed in JS.
///
/// The `__tsxUtils__` bridge (utils.rs) provides shared UTF-8, base64, and hex primitives.
/// JS shims should delegate to these instead of reimplementing encoding logic.
pub fn install_all(ctx: &Ctx<'_>) -> Result<()> {
    utils::install(ctx)?; // Install first — shared encoding bridge used by crypto, encoding, buffer, etc.
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
    net::install(ctx)?;
    tls::install(ctx)?;
    dgram::install(ctx)?;
    zlib::install(ctx)?; // After stream (depends on Transform)
    worker_threads::install(ctx)?;
    punycode::install(ctx)?;
    module_mod::install(ctx)?;
    cluster::install(ctx)?;
    dns::install(ctx)?;
    readline::install(ctx)?;
    tty::install(ctx)?;
    vm::install(ctx)?;
    v8::install(ctx)?;
    domain::install(ctx)?;
    string_decoder::install(ctx)?;
    ios_bridge::install(ctx)?;
    Ok(())
}

#[cfg(test)]
mod tests;
