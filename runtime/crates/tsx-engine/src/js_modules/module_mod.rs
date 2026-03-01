//! Module module - Node.js Module system internals.
//!
//! Provides Module class with createRequire and other utilities.

use rquickjs::{Ctx, Result};

const MODULE_JS: &str = include_str!("shims/module.js");

/// Install module module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(MODULE_JS)?;
    Ok(())
}
