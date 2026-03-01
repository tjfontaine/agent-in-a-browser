//! Net module - stub for WASM sandbox.
//!
//! TCP/socket operations are not available in WASM.

use rquickjs::{Ctx, Result};

const NET_JS: &str = include_str!("shims/net.js");

/// Install net module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(NET_JS)?;
    Ok(())
}
