//! Util module - Node.js util compatible subset.
//!
//! Provides format, inspect, promisify, inherits, deprecate, and types.

use rquickjs::{Ctx, Result};

const UTIL_JS: &str = include_str!("shims/util.js");

/// Install util module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(UTIL_JS)?;
    Ok(())
}
