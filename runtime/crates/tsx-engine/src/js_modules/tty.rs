//! TTY module - stub for WASM sandbox.
//!
//! TTY operations are not available in WASM.

use rquickjs::{Ctx, Result};

const TTY_JS: &str = include_str!("shims/tty.js");

/// Install tty module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(TTY_JS)?;
    Ok(())
}
