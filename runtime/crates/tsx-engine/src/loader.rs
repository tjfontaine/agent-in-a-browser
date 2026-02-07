//! Module loader that fetches from network or filesystem.

use rquickjs::loader::{ImportAttributes, Loader};
use rquickjs::module::Declared;
use rquickjs::{Ctx, Module, Result};
use std::path::Path;
use swc_common::{sync::Lrc, FileName, SourceMap};
use swc_ecma_ast::{Callee, EsVersion, Expr, ExprStmt, FnExpr, ModuleItem, Stmt};
use swc_ecma_codegen::{text_writer::JsWriter, Config, Emitter};
use swc_ecma_parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax};

use crate::http_client;
use crate::transpiler;

/// Hybrid loader that fetches modules from network (for URLs) or filesystem (for local paths).
pub struct HybridLoader;

impl Loader for HybridLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        path: &str,
        attributes: Option<ImportAttributes<'js>>,
    ) -> Result<Module<'js, Declared>> {
        let import_type = attributes
            .as_ref()
            .map(|attrs| attrs.get_type())
            .transpose()
            .map_err(|e| rquickjs::Error::new_loading_message(path, format!("{}", e)))?
            .flatten();

        let local_path = crate::resolver::file_url_to_path(path);
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
            let fs_path = local_path.as_deref().unwrap_or(path);
            // Read from WASI filesystem
            std::fs::read_to_string(fs_path)
                .map_err(|e| rquickjs::Error::new_loading_message(path, format!("{}", e)))?
        };

        // Auto-transpile TypeScript (modules don't need async IIFE wrapping)
        let fs_path = local_path.as_deref().unwrap_or(path);
        let js_source = match import_type.as_deref() {
            Some("json") => {
                let parsed: serde_json::Value = serde_json::from_str(&source).map_err(|e| {
                    rquickjs::Error::new_loading_message(path, format!("Invalid JSON module: {}", e))
                })?;
                format!("export default {};", parsed)
            }
            Some(other) => {
                return Err(rquickjs::Error::new_loading_message(
                    path,
                    format!("Unsupported import attribute type: {}", other),
                ));
            }
            None => {
                if fs_path.ends_with(".cjs") {
                    wrap_commonjs_as_esm_with_swc(fs_path, &source)
                        .map_err(|e| rquickjs::Error::new_loading_message(path, e))?
                } else if fs_path.ends_with(".ts") || fs_path.ends_with(".tsx") {
                    transpiler::transpile_code_only(&source)
                        .map_err(|e| rquickjs::Error::new_loading_message(path, e))?
                } else {
                    source
                }
            }
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
    let local_path = crate::resolver::file_url_to_path(path);
    let source = if path.starts_with("http://") || path.starts_with("https://") {
        fetch_url(path).await?
    } else {
        let fs_path = local_path.as_deref().unwrap_or(path);
        // Use std::fs for local file access (WASI filesystem)
        std::fs::read_to_string(fs_path).map_err(|e| format!("Failed to read {}: {}", path, e))?
    };

    // Auto-transpile TypeScript (modules don't need async IIFE wrapping)
    let fs_path = local_path.as_deref().unwrap_or(path);
    if fs_path.ends_with(".cjs") {
        return wrap_commonjs_as_esm_with_swc(fs_path, &source);
    }
    if fs_path.ends_with(".ts") || fs_path.ends_with(".tsx") {
        return transpiler::transpile_code_only(&source);
    }

    Ok(source)
}

fn wrap_commonjs_as_esm_with_swc(module_path: &str, source: &str) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let cjs_fm = cm.new_source_file(Lrc::new(FileName::Custom(module_path.into())), source.to_string());
    let cjs_lexer = Lexer::new(
        Syntax::Es(EsSyntax {
            allow_return_outside_function: true,
            ..Default::default()
        }),
        EsVersion::Es2020,
        StringInput::from(&*cjs_fm),
        None,
    );
    let mut cjs_parser = Parser::new_from(cjs_lexer);
    let cjs_script = cjs_parser
        .parse_script()
        .map_err(|e| format!("Failed to parse CommonJS source {}: {:?}", module_path, e))?;
    if let Some(err) = cjs_parser.take_errors().into_iter().next() {
        return Err(format!(
            "CommonJS parse error in {}: {:?}",
            module_path, err
        ));
    }

    let escaped_path = module_path.replace('\\', "\\\\").replace('\'', "\\'");
    let dirname = Path::new(module_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string());
    let escaped_dir = dirname.replace('\\', "\\\\").replace('\'', "\\'");

    let wrapper_source = format!(
        "const module = {{ exports: {{}} }};\n\
         const exports = module.exports;\n\
         (function (exports, require, module, __filename, __dirname) {{\n\
         }})(exports, require, module, '{}', '{}');\n\
         const __tsxCjs = module.exports;\n\
         export default __tsxCjs;\n",
        escaped_path, escaped_dir
    );
    let wrapper_fm =
        cm.new_source_file(Lrc::new(FileName::Custom("tsx-cjs-wrapper.mjs".into())), wrapper_source);
    let wrapper_lexer = Lexer::new(
        Syntax::Es(EsSyntax::default()),
        EsVersion::Es2020,
        StringInput::from(&*wrapper_fm),
        None,
    );
    let mut wrapper_parser = Parser::new_from(wrapper_lexer);
    let mut wrapper_module = wrapper_parser
        .parse_module()
        .map_err(|e| format!("Failed to parse generated CJS wrapper: {:?}", e))?;
    if let Some(err) = wrapper_parser.take_errors().into_iter().next() {
        return Err(format!("Generated CJS wrapper parse error: {:?}", err));
    }

    // Replace the empty IIFE body with parsed CommonJS statements.
    for item in &mut wrapper_module.body {
        if let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = item {
            if let Expr::Call(call_expr) = &mut **expr {
                if let Callee::Expr(callee_expr) = &mut call_expr.callee {
                    if let Expr::Paren(paren_expr) = &mut **callee_expr {
                        if let Expr::Fn(FnExpr { function, .. }) = &mut *paren_expr.expr {
                            if let Some(body) = &mut function.body {
                                body.stmts = cjs_script.body.clone();
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    let mut out = Vec::new();
    let mut emitter = Emitter {
        cfg: Config::default(),
        cm: cm.clone(),
        comments: None,
        wr: JsWriter::new(cm.clone(), "\n", &mut out, None),
    };
    emitter
        .emit_module(&wrapper_module)
        .map_err(|e| format!("Failed to emit CJS wrapper: {:?}", e))?;

    String::from_utf8(out).map_err(|e| format!("UTF-8 error in CJS wrapper: {}", e))
}
