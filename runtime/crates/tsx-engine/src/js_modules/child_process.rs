//! Child process module - stub for WASM sandbox.
//!
//! All functions throw because process spawning is not available in WASM.

use rquickjs::{Ctx, Result};

const CHILD_PROCESS_JS: &str = include_str!("shims/child_process.js");

/// Install child_process stub module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(CHILD_PROCESS_JS)?;
    Ok(())
}
