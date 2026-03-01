//! Cluster module - stub for WASM sandbox.
//!
//! Process clustering is not available in WASM.

use rquickjs::{Ctx, Result};

const CLUSTER_JS: &str = include_str!("shims/cluster.js");

/// Install cluster module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(CLUSTER_JS)?;
    Ok(())
}
