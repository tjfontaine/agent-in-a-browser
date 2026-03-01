//! HTTPS module - Node.js https compatible subset.
//!
//! Provides https.request(), https.get(), Agent, and Server stub.
//! Uses __syncFetch__ for actual network calls with https:// protocol.

use rquickjs::{Ctx, Result};

const HTTPS_JS: &str = include_str!("shims/https.js");

/// Install https module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(HTTPS_JS)?;
    Ok(())
}
