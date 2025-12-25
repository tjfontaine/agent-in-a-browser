//! Path module - Node.js path API.
//!
//! Provides POSIX path manipulation functions.

use rquickjs::{Ctx, Result};

// Embedded JS shim for path module
const PATH_JS: &str = include_str!("shims/path.js");

/// Install path object on the global.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(PATH_JS)?;
    Ok(())
}
