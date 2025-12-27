//! Buffer module - Node.js Buffer class.
//!
//! Provides Node.js-compatible Buffer for binary data handling.

use rquickjs::{Ctx, Result};

// Embedded JS shim for Buffer
const BUFFER_JS: &str = include_str!("shims/buffer.js");

/// Install Buffer class on the global object.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(BUFFER_JS)?;
    Ok(())
}
