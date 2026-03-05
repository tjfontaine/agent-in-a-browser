//! Crypto module - Node.js crypto compatible subset.
//!
//! Uses Rust crypto crates (md-5, sha1, sha2, hmac) exposed to QuickJS via bridge functions.

use rquickjs::{Ctx, Function, Result};

const CRYPTO_JS: &str = include_str!("shims/crypto.js");

/// Install crypto module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();

    // Expose Rust-side random bytes generator using wasi:random
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

    // Expose Rust-side hash digest: __tsxHashDigest__(algorithm, data_latin1) -> hash_latin1
    let hash_digest = Function::new(ctx.clone(), |algorithm: String, data: String| -> String {
        hash_bridge(&algorithm, &data)
    })?;
    globals.set("__tsxHashDigest__", hash_digest)?;

    // Expose Rust-side HMAC digest: __tsxHmacDigest__(algorithm, key_latin1, data_latin1) -> hmac_latin1
    let hmac_digest = Function::new(
        ctx.clone(),
        |algorithm: String, key: String, data: String| -> String {
            hmac_bridge(&algorithm, &key, &data)
        },
    )?;
    globals.set("__tsxHmacDigest__", hmac_digest)?;

    ctx.eval::<(), _>(CRYPTO_JS)?;
    Ok(())
}

/// Compute hash digest using Rust crypto crates.
/// Data is passed as latin1 string (each char = one byte).
/// Returns hash bytes as latin1 string.
fn hash_bridge(algorithm: &str, data_latin1: &str) -> String {
    use digest::Digest;

    let data: Vec<u8> = data_latin1.chars().map(|c| c as u8).collect();

    let result: Vec<u8> = match algorithm {
        "md5" => {
            let mut hasher = md5::Md5::new();
            hasher.update(&data);
            hasher.finalize().to_vec()
        }
        "sha1" | "sha-1" => {
            let mut hasher = sha1::Sha1::new();
            hasher.update(&data);
            hasher.finalize().to_vec()
        }
        "sha256" | "sha-256" => {
            let mut hasher = sha2::Sha256::new();
            hasher.update(&data);
            hasher.finalize().to_vec()
        }
        "sha512" | "sha-512" => {
            let mut hasher = sha2::Sha512::new();
            hasher.update(&data);
            hasher.finalize().to_vec()
        }
        _ => {
            // Return empty string for unsupported algorithms — JS side will throw
            return String::new();
        }
    };

    result.into_iter().map(|b| b as char).collect()
}

/// Compute HMAC digest using Rust hmac crate.
/// Key and data are passed as latin1 strings.
/// Returns HMAC bytes as latin1 string.
fn hmac_bridge(algorithm: &str, key_latin1: &str, data_latin1: &str) -> String {
    use hmac::{Hmac, Mac};

    let key: Vec<u8> = key_latin1.chars().map(|c| c as u8).collect();
    let data: Vec<u8> = data_latin1.chars().map(|c| c as u8).collect();

    let result: Vec<u8> = match algorithm {
        "md5" => {
            let mut mac =
                Hmac::<md5::Md5>::new_from_slice(&key).expect("HMAC accepts any key length");
            mac.update(&data);
            mac.finalize().into_bytes().to_vec()
        }
        "sha1" | "sha-1" => {
            let mut mac =
                Hmac::<sha1::Sha1>::new_from_slice(&key).expect("HMAC accepts any key length");
            mac.update(&data);
            mac.finalize().into_bytes().to_vec()
        }
        "sha256" | "sha-256" => {
            let mut mac =
                Hmac::<sha2::Sha256>::new_from_slice(&key).expect("HMAC accepts any key length");
            mac.update(&data);
            mac.finalize().into_bytes().to_vec()
        }
        "sha512" | "sha-512" => {
            let mut mac =
                Hmac::<sha2::Sha512>::new_from_slice(&key).expect("HMAC accepts any key length");
            mac.update(&data);
            mac.finalize().into_bytes().to_vec()
        }
        _ => {
            return String::new();
        }
    };

    result.into_iter().map(|b| b as char).collect()
}
