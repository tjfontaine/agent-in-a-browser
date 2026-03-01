//! DNS module - stub for WASM sandbox.
//!
//! DNS resolution is not available in WASM.

use rquickjs::{Ctx, Result};

const DNS_JS: &str = include_str!("shims/dns.js");

/// Install dns module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(DNS_JS)?;
    Ok(())
}
