//! TLS module - stub for WASM sandbox.
//!
//! TLS/SSL operations are not available in WASM.

use rquickjs::{Ctx, Result};

const TLS_JS: &str = include_str!("shims/tls.js");

/// Install tls module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(TLS_JS)?;
    Ok(())
}
