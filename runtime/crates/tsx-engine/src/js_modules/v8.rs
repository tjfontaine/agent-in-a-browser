//! V8 module - stub for WASM sandbox.
//!
//! V8-specific APIs are not available (runtime uses QuickJS).

use rquickjs::{Ctx, Result};

const V8_JS: &str = include_str!("shims/v8.js");

/// Install v8 module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(V8_JS)?;
    Ok(())
}
