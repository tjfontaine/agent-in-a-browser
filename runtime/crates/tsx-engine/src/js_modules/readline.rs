//! Readline module - stub for WASM sandbox.
//!
//! Interactive readline is limited in WASM.

use rquickjs::{Ctx, Result};

const READLINE_JS: &str = include_str!("shims/readline.js");

/// Install readline module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(READLINE_JS)?;
    Ok(())
}
