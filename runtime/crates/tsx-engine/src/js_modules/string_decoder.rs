//! string_decoder module - Node.js string_decoder compatible subset.
//!
//! Provides StringDecoder for incremental multi-byte character decoding.

use rquickjs::{Ctx, Result};

const STRING_DECODER_JS: &str = include_str!("shims/string_decoder.js");

/// Install string_decoder module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(STRING_DECODER_JS)?;
    Ok(())
}
