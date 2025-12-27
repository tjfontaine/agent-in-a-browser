//! URL module - Web URL and URLSearchParams.
//!
//! Provides Web API URL parsing and manipulation.

use rquickjs::{Ctx, Result};

// Embedded JS shim for URL
const URL_JS: &str = include_str!("shims/url.js");

/// Install URL and URLSearchParams on the global object.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(URL_JS)?;
    Ok(())
}
