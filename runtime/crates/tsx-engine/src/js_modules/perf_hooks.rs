//! Performance hooks module - Node.js perf_hooks compatible subset.
//!
//! Provides performance.now(), marks, measures, and PerformanceObserver stub.

use rquickjs::{Ctx, Result};

const PERF_HOOKS_JS: &str = include_str!("shims/perf_hooks.js");

/// Install perf_hooks module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(PERF_HOOKS_JS)?;
    Ok(())
}
