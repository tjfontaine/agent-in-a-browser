//! Host API bindings for the QuickJS context.
//!
//! Provides console, fetch, and fs.promises bindings.

use rquickjs::prelude::Rest;
use rquickjs::{Ctx, Function, Object, Result, Value};

// Captured console output logs.
// These are accumulated during code execution and returned to the host.
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
/// Provides a standard Web Fetch API-compatible interface.
/// fetch() returns Promise<Response>, and Response.text()/json() return Promises.
pub fn install_fetch(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();

    // Create a low-level sync fetch function that accepts options
    let sync_fetch_fn = Function::new(ctx.clone(), |args: Rest<Value>| {
        // Get URL from first argument
        let url = args.0.first().and_then(|v| v.as_string()).and_then(|s| s.to_string().ok());
        
        // Get options JSON from second argument (method, headers, body)
        let options_json = args.0.get(1).and_then(|v| v.as_string()).and_then(|s| s.to_string().ok());

        match url {
            Some(url_str) => {
                // Parse options if provided
                let (method, headers_json, body) = if let Some(opts) = &options_json {
                    // Parse the options JSON
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
                
                // Make the synchronous HTTP request
                let result = crate::http_client::fetch_request(
                    &method,
                    &url_str,
                    headers_json.as_deref(),
                    body.as_deref(),
                );
                
                match result {
                    Ok(response) => {
                        // Return JSON with headers array for reconstruction
                        serde_json::json!({
                            "ok": response.ok,
                            "status": response.status,
                            "statusText": if response.ok { "OK" } else { "" },
                            "headers": [],  // TODO: parse response headers from WASI HTTP
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

    // Create standard Web Fetch API in JavaScript
    ctx.eval::<(), _>(
        r#"
        // Standard Headers class
        globalThis.Headers = class Headers {
            constructor(init) {
                this._headers = {};
                if (init) {
                    if (init instanceof Headers) {
                        init.forEach((value, name) => this.append(name, value));
                    } else if (Array.isArray(init)) {
                        init.forEach(([name, value]) => this.append(name, value));
                    } else if (typeof init === 'object') {
                        Object.entries(init).forEach(([name, value]) => this.append(name, value));
                    }
                }
            }
            append(name, value) {
                const key = name.toLowerCase();
                if (this._headers[key]) {
                    this._headers[key] += ', ' + value;
                } else {
                    this._headers[key] = String(value);
                }
            }
            delete(name) {
                delete this._headers[name.toLowerCase()];
            }
            get(name) {
                return this._headers[name.toLowerCase()] || null;
            }
            has(name) {
                return name.toLowerCase() in this._headers;
            }
            set(name, value) {
                this._headers[name.toLowerCase()] = String(value);
            }
            entries() {
                return Object.entries(this._headers)[Symbol.iterator]();
            }
            keys() {
                return Object.keys(this._headers)[Symbol.iterator]();
            }
            values() {
                return Object.values(this._headers)[Symbol.iterator]();
            }
            forEach(callback, thisArg) {
                Object.entries(this._headers).forEach(([name, value]) => {
                    callback.call(thisArg, value, name, this);
                });
            }
            // For JSON serialization
            toJSON() {
                return this._headers;
            }
        };

        // Standard Response class with Promise-returning methods
        globalThis.Response = class Response {
            constructor(body, init = {}) {
                this._body = body || '';
                this._bodyUsed = false;
                this.status = init.status || 200;
                this.statusText = init.statusText || '';
                this.ok = this.status >= 200 && this.status < 300;
                this.headers = new Headers(init.headers);
                this.type = 'basic';
                this.url = init.url || '';
                this.redirected = false;
            }
            get body() { return null; } // No ReadableStream support
            get bodyUsed() { return this._bodyUsed; }
            text() {
                this._bodyUsed = true;
                // Return Promise for standard API compliance
                return Promise.resolve(this._body);
            }
            json() {
                this._bodyUsed = true;
                // Return Promise for standard API compliance
                try {
                    return Promise.resolve(JSON.parse(this._body));
                } catch (e) {
                    return Promise.reject(e);
                }
            }
            arrayBuffer() {
                this._bodyUsed = true;
                const encoder = new TextEncoder();
                return Promise.resolve(encoder.encode(this._body).buffer);
            }
            blob() {
                return Promise.reject(new Error('Blob not supported in this environment'));
            }
            formData() {
                return Promise.reject(new Error('FormData not supported in this environment'));
            }
            clone() {
                if (this._bodyUsed) {
                    throw new TypeError('Cannot clone a Response whose body is already used');
                }
                return new Response(this._body, {
                    status: this.status,
                    statusText: this.statusText,
                    headers: this.headers,
                    url: this.url
                });
            }
        };

        // Standard fetch function - returns Promise<Response>
        globalThis.fetch = function(resource, options = {}) {
            return new Promise((resolve, reject) => {
                try {
                    // Handle Request objects
                    let url = resource;
                    if (typeof resource === 'object' && resource.url) {
                        url = resource.url;
                        options = { ...resource, ...options };
                    }
                    
                    // Build options JSON for Rust
                    const fetchOptions = {
                        method: options.method || 'GET',
                        headers: {},
                        body: options.body
                    };
                    
                    // Convert headers to plain object
                    if (options.headers) {
                        if (options.headers instanceof Headers) {
                            options.headers.forEach((value, name) => {
                                fetchOptions.headers[name] = value;
                            });
                        } else if (Array.isArray(options.headers)) {
                            options.headers.forEach(([name, value]) => {
                                fetchOptions.headers[name] = value;
                            });
                        } else {
                            fetchOptions.headers = options.headers;
                        }
                    }
                    
                    const resultJson = __syncFetch__(url, JSON.stringify(fetchOptions));
                    const result = JSON.parse(resultJson);
                    
                    // Build Headers from response
                    const responseHeaders = new Headers(result.headers || []);
                    
                    // Resolve with standard Response object
                    resolve(new Response(result.body, {
                        status: result.status,
                        statusText: result.statusText,
                        headers: responseHeaders,
                        url: url
                    }));
                } catch (e) {
                    // Reject with error for network failures
                    reject(new TypeError('Network request failed: ' + e.message));
                }
            });
        };
    "#,
    )?;

    Ok(())
}

