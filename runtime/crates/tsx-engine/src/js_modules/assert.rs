//! Assert module - Node.js assert compatible subset.
//!
//! Provides assert, strictEqual, deepStrictEqual, throws, and fail.

use rquickjs::{Ctx, Result};

const ASSERT_JS: &str = include_str!("shims/assert.js");

/// Install assert module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(ASSERT_JS)?;
    Ok(())
}
