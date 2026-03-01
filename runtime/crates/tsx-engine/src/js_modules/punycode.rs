//! Punycode module - internationalized domain name encoding.
//!
//! Provides punycode encode/decode and toASCII/toUnicode for domain names.

use rquickjs::{Ctx, Result};

const PUNYCODE_JS: &str = include_str!("shims/punycode.js");

/// Install punycode module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(PUNYCODE_JS)?;
    Ok(())
}
