//! Stream module - Node.js stream compatible subset.
//!
//! Provides lightweight Readable, Writable, Transform, and PassThrough.

use rquickjs::{Ctx, Result};

const STREAM_JS: &str = include_str!("shims/stream.js");

/// Install stream module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(STREAM_JS)?;
    Ok(())
}
