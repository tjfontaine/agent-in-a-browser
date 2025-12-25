//! Fetch module - Web Fetch API implementation.
//!
//! Uses embedded JS shims for Headers, Response, and fetch.
//! The low-level __syncFetch__ is provided by Rust via WASI HTTP.

use rquickjs::prelude::Rest;
use rquickjs::{Ctx, Function, Result, Value};

// Embedded JS shims - real .js files for IDE linting
const HEADERS_JS: &str = include_str!("shims/headers.js");
const RESPONSE_JS: &str = include_str!("shims/response.js");
const FETCH_JS: &str = include_str!("shims/fetch.js");

/// Install fetch API on the global object.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();

    // Create low-level sync fetch function that the JS shim calls
    let sync_fetch_fn = Function::new(ctx.clone(), |args: Rest<Value>| {
        let url = args.0.first().and_then(|v| v.as_string()).and_then(|s| s.to_string().ok());
        let options_json = args.0.get(1).and_then(|v| v.as_string()).and_then(|s| s.to_string().ok());

        match url {
            Some(url_str) => {
                let (method, headers_json, body) = if let Some(opts) = &options_json {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(opts) {
                        let m = parsed.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
                        let h = parsed.get("headers").map(|v| v.to_string());
                        let b = parsed.get("body").and_then(|v| v.as_str()).map(|s| s.to_string());
                        (m.to_string(), h, b)
                    } else {
                        ("GET".to_string(), None, None)
                    }
                } else {
                    ("GET".to_string(), None, None)
                };
                
                let result = crate::http_client::fetch_request(
                    &method,
                    &url_str,
                    headers_json.as_deref(),
                    body.as_deref(),
                );
                
                match result {
                    Ok(response) => {
                        serde_json::json!({
                            "ok": response.ok,
                            "status": response.status,
                            "statusText": if response.ok { "OK" } else { "" },
                            "headers": [],
                            "body": response.body
                        }).to_string()
                    }
                    Err(e) => {
                        eprintln!("[__syncFetch__] Error: {}", e);
                        serde_json::json!({
                            "ok": false,
                            "status": 0,
                            "statusText": e,
                            "headers": [],
                            "body": ""
                        }).to_string()
                    }
                }
            }
            None => {
                serde_json::json!({
                    "ok": false,
                    "status": 0,
                    "statusText": "No URL provided",
                    "headers": [],
                    "body": ""
                }).to_string()
            }
        }
    })?;

    globals.set("__syncFetch__", sync_fetch_fn)?;

    // Evaluate embedded JS shims
    ctx.eval::<(), _>(HEADERS_JS)?;
    ctx.eval::<(), _>(RESPONSE_JS)?;
    ctx.eval::<(), _>(FETCH_JS)?;

    Ok(())
}
