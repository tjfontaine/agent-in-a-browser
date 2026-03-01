//! Crypto module - Node.js crypto compatible subset.
//!
//! Provides randomBytes, randomUUID, and createHash (sha256).

use rquickjs::{Ctx, Function, Result};

const CRYPTO_JS: &str = include_str!("shims/crypto.js");

/// Install crypto module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    // Expose Rust-side random bytes generator using wasi:random
    let globals = ctx.globals();
    let get_random_bytes = Function::new(ctx.clone(), |n: usize| -> String {
        #[cfg(target_arch = "wasm32")]
        {
            let bytes = crate::bindings::wasi::random::random::get_random_bytes(n as u64);
            bytes.into_iter().map(|b| b as char).collect()
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            // For native tests, use simple pseudo-random
            (0..n)
                .map(|i| ((i * 17 + 31) % 256) as u8 as char)
                .collect()
        }
    })?;
    globals.set("__tsxGetRandomBytes__", get_random_bytes)?;

    ctx.eval::<(), _>(CRYPTO_JS)?;
    Ok(())
}
