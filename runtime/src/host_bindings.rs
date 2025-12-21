//! Host API bindings for the QuickJS context.
//!
//! Provides console, fetch, and fs.promises bindings.

use rquickjs::prelude::Rest;
use rquickjs::{Ctx, Function, Object, Result, Value};

/// Captured console output logs.
/// These are accumulated during code execution and returned to the host.
thread_local! {
    pub static CAPTURED_LOGS: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
}

/// Clear captured logs.
pub fn clear_logs() {
    CAPTURED_LOGS.with(|logs| logs.borrow_mut().clear());
}

/// Get captured logs as a single string.
pub fn get_logs() -> String {
    CAPTURED_LOGS.with(|logs| logs.borrow().join("\n"))
}

/// Install console bindings on the global object.
pub fn install_console(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();

    // Create console object
    let console = Object::new(ctx.clone())?;

    // console.log
    let log_fn = Function::new(ctx.clone(), |args: Rest<Value>| {
        let output = format_args_to_string(&args.0);
        eprintln!("[console.log] {}", output);
        CAPTURED_LOGS.with(|logs| logs.borrow_mut().push(output));
    })?;
    console.set("log", log_fn)?;

    // console.error
    let error_fn = Function::new(ctx.clone(), |args: Rest<Value>| {
        let output = format!("ERROR: {}", format_args_to_string(&args.0));
        eprintln!("[console.error] {}", output);
        CAPTURED_LOGS.with(|logs| logs.borrow_mut().push(output));
    })?;
    console.set("error", error_fn)?;

    // console.warn
    let warn_fn = Function::new(ctx.clone(), |args: Rest<Value>| {
        let output = format!("WARN: {}", format_args_to_string(&args.0));
        eprintln!("[console.warn] {}", output);
        CAPTURED_LOGS.with(|logs| logs.borrow_mut().push(output));
    })?;
    console.set("warn", warn_fn)?;

    // console.info
    let info_fn = Function::new(ctx.clone(), |args: Rest<Value>| {
        let output = format_args_to_string(&args.0);
        eprintln!("[console.info] {}", output);
        CAPTURED_LOGS.with(|logs| logs.borrow_mut().push(output));
    })?;
    console.set("info", info_fn)?;

    globals.set("console", console)?;
    Ok(())
}

/// Install a simple path object on the global.
pub fn install_path(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();

    // Create path object with basic methods
    ctx.eval::<(), _>(r#"
        globalThis.path = {
            join: (...p) => p.filter(Boolean).join('/').replace(/\/\/+/g, '/'),
            resolve: (...p) => '/' + p.filter(Boolean).join('/').replace(/\/\/+/g, '/').replace(/^\/+/, ''),
            dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
            basename: (p, ext) => { const b = p.split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
            extname: (p) => { const b = p.split('/').pop() || ''; const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
            sep: '/',
            delimiter: ':'
        };
    "#)?;

    let _ = globals; // Silence unused warning
    Ok(())
}

/// Format an array of JavaScript values to a string.
fn format_args_to_string(args: &[Value]) -> String {
    args.iter()
        .map(|v| value_to_string(v))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Convert a JavaScript value to a string representation.
fn value_to_string(val: &Value) -> String {
    if val.is_undefined() {
        "undefined".to_string()
    } else if val.is_null() {
        "null".to_string()
    } else if let Some(s) = val.as_string() {
        s.to_string().unwrap_or_default()
    } else if let Some(n) = val.as_number() {
        format!("{}", n)
    } else if let Some(b) = val.as_bool() {
        format!("{}", b)
    } else if val.is_object() {
        // Try to convert object to JSON-like string
        "[object]".to_string()
    } else if val.is_array() {
        "[array]".to_string()
    } else {
        format!("{:?}", val)
    }
}

/// Install fs and fs.promises on the global object.
/// These use __hostFs__ callbacks that must be provided by the host environment.
pub fn install_fs(ctx: &Ctx<'_>) -> Result<()> {
    // Create fs.promises that delegates to __hostFs__ host functions
    // The host environment (sandbox-worker) will inject __hostFs__ before eval
    ctx.eval::<(), _>(
        r#"
        globalThis.__hostFs__ = globalThis.__hostFs__ || {};
        
        globalThis.fs = {
            promises: {
                readFile: async (path, options) => {
                    if (typeof globalThis.__hostFs__.readFile === 'function') {
                        return globalThis.__hostFs__.readFile(path, options);
                    }
                    throw new Error('fs.readFile not available - host fs not injected');
                },
                writeFile: async (path, data, options) => {
                    if (typeof globalThis.__hostFs__.writeFile === 'function') {
                        return globalThis.__hostFs__.writeFile(path, data, options);
                    }
                    throw new Error('fs.writeFile not available - host fs not injected');
                },
                readdir: async (path) => {
                    if (typeof globalThis.__hostFs__.readdir === 'function') {
                        return globalThis.__hostFs__.readdir(path);
                    }
                    throw new Error('fs.readdir not available - host fs not injected');
                },
                mkdir: async (path, options) => {
                    if (typeof globalThis.__hostFs__.mkdir === 'function') {
                        return globalThis.__hostFs__.mkdir(path, options);
                    }
                    throw new Error('fs.mkdir not available - host fs not injected');
                },
                rm: async (path, options) => {
                    if (typeof globalThis.__hostFs__.rm === 'function') {
                        return globalThis.__hostFs__.rm(path, options);
                    }
                    throw new Error('fs.rm not available - host fs not injected');
                },
                stat: async (path) => {
                    if (typeof globalThis.__hostFs__.stat === 'function') {
                        return globalThis.__hostFs__.stat(path);
                    }
                    throw new Error('fs.stat not available - host fs not injected');
                }
            }
        };
    "#,
    )?;

    Ok(())
}

/// Install fetch on the global object.
/// Uses custom browser-http WIT interface for synchronous HTTP requests.
pub fn install_fetch(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();

    // Create a low-level sync fetch function that returns JSON string
    let sync_fetch_fn = Function::new(ctx.clone(), |args: Rest<Value>| {
        eprintln!("[__syncFetch__] Called with {} args", args.0.len());
        
        // Get URL from first argument
        let url = args.0.first().and_then(|v| v.as_string()).and_then(|s| s.to_string().ok());
        eprintln!("[__syncFetch__] URL: {:?}", url);

        match url {
            Some(url_str) => {
                eprintln!("[__syncFetch__] Making request to: {}", url_str);
                // Make the synchronous HTTP request via browser-http interface
                match crate::http_client::fetch_sync(&url_str) {
                    Ok(response) => {
                        eprintln!("[__syncFetch__] Got response: status={}, ok={}", response.status, response.ok);
                        // Return a JSON result that JS can parse
                        serde_json::json!({
                            "ok": response.ok,
                            "status": response.status,
                            "body": response.body
                        }).to_string()
                    }
                    Err(e) => {
                        eprintln!("[__syncFetch__] Error: {}", e);
                        serde_json::json!({
                            "ok": false,
                            "status": 0,
                            "error": e
                        }).to_string()
                    }
                }
            }
            None => {
                eprintln!("[__syncFetch__] No URL provided");
                serde_json::json!({
                    "ok": false,
                    "status": 0,
                    "error": "No URL provided"
                }).to_string()
            }
        }
    })?;

    globals.set("__syncFetch__", sync_fetch_fn)?;

    // Create high-level fetch function in JavaScript that wraps __syncFetch__
    ctx.eval::<(), _>(
        r#"
        globalThis.fetch = function(url, options) {
            console.log('[fetch] Called with URL:', url);
            console.log('[fetch] __syncFetch__ type:', typeof __syncFetch__);
            
            try {
                const resultJson = __syncFetch__(url);
                console.log('[fetch] Got result JSON:', resultJson);
                const result = JSON.parse(resultJson);
                console.log('[fetch] Parsed result:', result);
                
                return {
                    ok: result.ok,
                    status: result.status,
                    statusText: result.ok ? 'OK' : (result.error || ''),
                    _body: result.body || '',
                    text: function() { return this._body; },
                    json: function() { return JSON.parse(this._body); }
                };
            } catch (e) {
                console.log('[fetch] Error:', e.message);
                return {
                    ok: false,
                    status: 0,
                    statusText: 'fetch error: ' + e.message,
                    _body: '',
                    text: function() { return ''; },
                    json: function() { return {}; }
                };
            }
        };
    "#,
    )?;

    Ok(())
}
