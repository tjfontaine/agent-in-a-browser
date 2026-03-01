//! Worker threads module - stub for WASM sandbox.
//!
//! Worker threads are not available in WASM.

use rquickjs::{Ctx, Result};

const WORKER_THREADS_JS: &str = include_str!("shims/worker_threads.js");

/// Install worker_threads module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(WORKER_THREADS_JS)?;
    Ok(())
}
