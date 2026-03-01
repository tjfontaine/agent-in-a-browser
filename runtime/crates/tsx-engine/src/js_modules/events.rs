//! Events module - Node.js EventEmitter class.
//!
//! Provides Node.js-compatible EventEmitter for event-driven programming.

use rquickjs::{Ctx, Result};

const EVENTS_JS: &str = include_str!("shims/events.js");

/// Install EventEmitter on the global object and register as a built-in module.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(EVENTS_JS)?;
    Ok(())
}
