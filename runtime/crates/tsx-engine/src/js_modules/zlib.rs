//! Zlib module - compression stubs for WASM sandbox.
//!
//! Provides zlib constants and stub Transform streams.

use rquickjs::{Ctx, Result};

const ZLIB_JS: &str = include_str!("shims/zlib.js");

/// Install zlib module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(ZLIB_JS)?;
    Ok(())
}
