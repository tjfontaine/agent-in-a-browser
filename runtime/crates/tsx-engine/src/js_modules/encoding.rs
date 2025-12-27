//! Encoding module - TextEncoder and TextDecoder.
//!
//! Provides Web API text encoding/decoding.

use rquickjs::{Ctx, Result};

// Embedded JS shim for encoding
const ENCODING_JS: &str = include_str!("shims/encoding.js");

/// Install TextEncoder and TextDecoder on the global object.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(ENCODING_JS)?;
    Ok(())
}
