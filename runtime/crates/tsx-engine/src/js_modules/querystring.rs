//! querystring module - Node.js query string parsing and formatting.
//!
//! Provides query string serialization/deserialization compatible with Node.js.

use rquickjs::{Ctx, Result};

// Embedded JS shim for querystring
const QUERYSTRING_JS: &str = include_str!("shims/querystring.js");

/// Install the querystring module as a built-in module.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(QUERYSTRING_JS)?;
    Ok(())
}
