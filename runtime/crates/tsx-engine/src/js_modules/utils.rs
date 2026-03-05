//! Shared encoding utilities exposed as `globalThis.__tsxUtils__`.
//!
//! Provides canonical UTF-8, base64, and hex encode/decode primitives for JS shims.
//! All binary data is passed as **latin1 strings** (each JS char = one byte, code points 0–255).
//! This matches the convention established by `crypto.rs`.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rquickjs::{Ctx, Function, Object, Result};

/// Install `globalThis.__tsxUtils__` with encoding bridge functions.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();
    let utils = Object::new(ctx.clone())?;

    // utf8Encode(str) → latin1 string of UTF-8 bytes
    utils.set(
        "utf8Encode",
        Function::new(ctx.clone(), |s: String| -> String {
            s.as_bytes().iter().map(|&b| b as char).collect()
        })?,
    )?;

    // utf8Decode(latin1) → JS string
    utils.set(
        "utf8Decode",
        Function::new(ctx.clone(), |latin1: String| -> String {
            let bytes: Vec<u8> = latin1.chars().map(|c| c as u8).collect();
            String::from_utf8_lossy(&bytes).into_owned()
        })?,
    )?;

    // base64Encode(latin1) → base64 string
    utils.set(
        "base64Encode",
        Function::new(ctx.clone(), |latin1: String| -> String {
            let bytes: Vec<u8> = latin1.chars().map(|c| c as u8).collect();
            BASE64.encode(&bytes)
        })?,
    )?;

    // base64Decode(str) → latin1 string of decoded bytes
    utils.set(
        "base64Decode",
        Function::new(ctx.clone(), |b64: String| -> String {
            match BASE64.decode(&b64) {
                Ok(bytes) => bytes.into_iter().map(|b| b as char).collect(),
                Err(_) => String::new(),
            }
        })?,
    )?;

    // hexEncode(latin1) → hex string
    utils.set(
        "hexEncode",
        Function::new(ctx.clone(), |latin1: String| -> String {
            latin1
                .chars()
                .map(|c| format!("{:02x}", c as u8))
                .collect()
        })?,
    )?;

    // hexDecode(str) → latin1 string of decoded bytes
    utils.set(
        "hexDecode",
        Function::new(ctx.clone(), |hex: String| -> String {
            let mut bytes = Vec::with_capacity(hex.len() / 2);
            let chars: Vec<char> = hex.chars().collect();
            let mut i = 0;
            while i + 1 < chars.len() {
                if let Ok(b) = u8::from_str_radix(&hex[i..i + 2], 16) {
                    bytes.push(b as char);
                }
                i += 2;
            }
            bytes.into_iter().collect()
        })?,
    )?;

    globals.set("__tsxUtils__", utils)?;
    Ok(())
}
