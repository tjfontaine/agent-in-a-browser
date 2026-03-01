//! HTTP module - Node.js http compatible subset.
//!
//! Provides http.request(), http.get(), Agent, Server/ServerResponse stubs,
//! IncomingMessage, ClientRequest, METHODS, and STATUS_CODES.
//! Uses __syncFetch__ for actual network calls with http:// protocol.

use rquickjs::{Ctx, Result};

const HTTP_JS: &str = include_str!("shims/http.js");

/// Install http module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    ctx.eval::<(), _>(HTTP_JS)?;
    Ok(())
}
