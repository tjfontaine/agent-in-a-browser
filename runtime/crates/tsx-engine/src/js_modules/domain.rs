//! Domain module - deprecated error handling domains.
//!
//! Stub implementation of the deprecated Node.js domain module.

use rquickjs::{Ctx, Result};

const DOMAIN_JS: &str = include_str!("shims/domain.js");

/// Install domain module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(DOMAIN_JS)?;
    Ok(())
}
