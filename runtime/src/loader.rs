//! Module loader that fetches from network or filesystem.

use rquickjs::loader::Loader;
use rquickjs::module::Declared;
use rquickjs::{Ctx, Module, Result};

use crate::http_client;
use crate::transpiler;

/// Hybrid loader that fetches modules from network (for URLs) or filesystem (for local paths).
pub struct HybridLoader;

impl Loader for HybridLoader {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, path: &str) -> Result<Module<'js, Declared>> {
        // Fetch source code
        let source = if path.starts_with("https://") || path.starts_with("http://") {
            // Fetch from URL using synchronous WASI HTTP
            match http_client::fetch_sync(path) {
                Ok(response) if response.ok => response.body(),
                Ok(response) => {
                    return Err(rquickjs::Error::new_loading_message(
                        path,
                        format!("HTTP {}", response.status),
                    ));
                }
                Err(e) => {
                    return Err(rquickjs::Error::new_loading_message(path, e));
                }
            }
        } else {
            // Read from WASI filesystem
            std::fs::read_to_string(path).map_err(|e| {
                rquickjs::Error::new_loading_message(path, format!("{}", e))
            })?
        };

        // Auto-transpile TypeScript
        let js_source = if path.ends_with(".ts") || path.ends_with(".tsx") {
            transpiler::transpile(&source).map_err(|e| {
                rquickjs::Error::new_loading_message(path, e)
            })?
        } else {
            source
        };

        // Declare the module
        Module::declare(ctx.clone(), path, js_source)
    }
}

/// Fetch content from a URL using the browser's fetch API.
///
/// This is called from async context.
#[allow(dead_code)]
pub async fn fetch_url(url: &str) -> std::result::Result<String, String> {
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::JsFuture;

    // Get the global scope (works in both Window and Worker contexts)
    let global = js_sys::global();

    // Call fetch
    let fetch_fn = js_sys::Reflect::get(&global, &"fetch".into())
        .map_err(|_| "fetch not available".to_string())?;

    let fetch_fn: js_sys::Function = fetch_fn
        .dyn_into()
        .map_err(|_| "fetch is not a function".to_string())?;

    let promise = fetch_fn
        .call1(&JsValue::UNDEFINED, &JsValue::from_str(url))
        .map_err(|e| format!("fetch call failed: {:?}", e))?;

    let resp = JsFuture::from(js_sys::Promise::from(promise))
        .await
        .map_err(|e| format!("fetch failed: {:?}", e))?;

    let resp: web_sys::Response = resp
        .dyn_into()
        .map_err(|_| "response is not a Response".to_string())?;

    if !resp.ok() {
        return Err(format!("HTTP {}: {}", resp.status(), resp.status_text()));
    }

    let text_promise = resp.text().map_err(|e| format!("text() failed: {:?}", e))?;

    let text = JsFuture::from(text_promise)
        .await
        .map_err(|e| format!("text await failed: {:?}", e))?;

    text.as_string()
        .ok_or_else(|| "response text is not a string".to_string())
}

/// Load a module from the given path (URL or local).
#[allow(dead_code)]
pub async fn load_module(path: &str) -> std::result::Result<String, String> {
    let source = if path.starts_with("http://") || path.starts_with("https://") {
        fetch_url(path).await?
    } else {
        // Use std::fs for local file access (WASI filesystem)
        std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {}", path, e))?
    };

    // Auto-transpile TypeScript
    if path.ends_with(".ts") || path.ends_with(".tsx") {
        return transpiler::transpile(&source);
    }

    Ok(source)
}
