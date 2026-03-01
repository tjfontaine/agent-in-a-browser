//! OS module - Node.js os compatible subset.
//!
//! Provides platform info, memory stats, and system defaults for WASM.

use rquickjs::{Ctx, Result};

const OS_JS: &str = include_str!("shims/os.js");

/// Install os module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(OS_JS)?;
    Ok(())
}
