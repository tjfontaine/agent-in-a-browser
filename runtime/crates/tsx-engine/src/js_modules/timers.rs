//! Timers module - Node.js timers compatible subset.
//!
//! Re-exports the timer globals (setTimeout, setInterval, etc.) as a module
//! and provides timers/promises with promisified versions.

use rquickjs::{Ctx, Result};

const TIMERS_JS: &str = include_str!("shims/timers.js");

/// Install timers module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(TIMERS_JS)?;
    Ok(())
}
