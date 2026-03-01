//! VM module - code evaluation for WASM sandbox.
//!
//! Provides basic Script and runInNewContext/runInThisContext using eval.

use rquickjs::{Ctx, Result};

const VM_JS: &str = include_str!("shims/vm.js");

/// Install vm module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(VM_JS)?;
    Ok(())
}
