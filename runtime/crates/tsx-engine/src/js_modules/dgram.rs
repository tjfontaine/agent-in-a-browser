//! Dgram module - stub for WASM sandbox.
//!
//! UDP/datagram operations are not available in WASM.

use rquickjs::{Ctx, Result};

const DGRAM_JS: &str = include_str!("shims/dgram.js");

/// Install dgram module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(DGRAM_JS)?;
    Ok(())
}
