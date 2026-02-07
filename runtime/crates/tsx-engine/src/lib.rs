//! tsx-engine module
//!
//! Provides tsx/tsc commands via the unix-command WIT interface.
//! tsx-engine is like ts-node: it transpiles TypeScript and executes it.
//! Includes Node.js-compatible shims for console, fs, path, Buffer, fetch, etc.

#[allow(warnings)]
mod bindings;
mod http_client;
mod js_modules;
mod loader;
mod resolver;
mod transpiler;

use bindings::exports::shell::unix::command::{ExecEnv, Guest};
use bindings::wasi::io::streams::{InputStream, OutputStream};
use std::time::{Duration, Instant};

// QuickJS runtime for execution
use rquickjs::{context::EvalOptions, AsyncContext, AsyncRuntime, CatchResultExt};

const QUICKJS_MEMORY_LIMIT_BYTES: usize = 256 * 1024 * 1024;
const QUICKJS_MAX_STACK_BYTES: usize = 1024 * 1024;
const QUICKJS_GC_THRESHOLD_BYTES: usize = 32 * 1024 * 1024;
const QUICKJS_EXECUTION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
struct RuntimeLimits {
    memory_limit_bytes: usize,
    max_stack_bytes: usize,
    gc_threshold_bytes: usize,
    execution_timeout: Duration,
}

const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = RuntimeLimits {
    memory_limit_bytes: QUICKJS_MEMORY_LIMIT_BYTES,
    max_stack_bytes: QUICKJS_MAX_STACK_BYTES,
    gc_threshold_bytes: QUICKJS_GC_THRESHOLD_BYTES,
    execution_timeout: QUICKJS_EXECUTION_TIMEOUT,
};

struct TsxEngine;

impl Guest for TsxEngine {
    fn run(
        name: String,
        args: Vec<String>,
        env: ExecEnv,
        stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) -> i32 {
        match name.as_str() {
            "tsx" => run_tsx(args, stdin, stdout, stderr, env),
            "tsc" => run_tsc(args, stdin, stdout, stderr),
            _ => {
                write_to_stream(&stderr, format!("Unknown command: {}\n", name).as_bytes());
                127
            }
        }
    }

    fn list_commands() -> Vec<String> {
        vec!["tsx".to_string(), "tsc".to_string()]
    }
}

/// Execute TypeScript/JavaScript code (transpile + execute, like ts-node)
fn run_tsx(
    args: Vec<String>,
    stdin: InputStream,
    stdout: OutputStream,
    stderr: OutputStream,
    env: ExecEnv,
) -> i32 {
    // Parse arguments
    let mut code: Option<String> = None;
    let mut file_path: Option<String> = None;
    let mut script_args: Vec<String> = Vec::new();
    let mut i = 0;
    let mut parse_options = true;

    while i < args.len() {
        let arg = &args[i];
        if !parse_options {
            script_args.push(arg.clone());
            i += 1;
            continue;
        }

        match arg.as_str() {
            "--" => {
                parse_options = false;
                i += 1;
            }
            "-e" | "--eval" => {
                if i + 1 < args.len() {
                    code = Some(args[i + 1].clone());
                    i += 2;
                } else {
                    write_to_stream(&stderr, b"tsx: -e requires an argument\n");
                    return 1;
                }
            }
            "-h" | "--help" => {
                write_to_stream(&stdout, b"Usage: tsx [options] [file]\n");
                write_to_stream(&stdout, b"  -e, --eval <code>  Evaluate code\n");
                write_to_stream(&stdout, b"  -h, --help         Show this help\n");
                write_to_stream(
                    &stdout,
                    b"\nTranspiles TypeScript and executes it (like ts-node).\n",
                );
                write_to_stream(
                    &stdout,
                    b"Includes: console, fs, path, Buffer, fetch, URL, etc.\n",
                );
                return 0;
            }
            value if !value.starts_with('-') => {
                file_path = Some(value.to_string());
                i += 1;
                if i < args.len() {
                    script_args.extend(args[i..].iter().cloned());
                }
                break;
            }
            _ => {
                write_to_stream(
                    &stderr,
                    format!("tsx: unknown option: {}\n", arg).as_bytes(),
                );
                return 1;
            }
        }
    }

    // Get TypeScript code from -e, file, or stdin
    let (ts_code, source_name) = if let Some(c) = code {
        (c, "<eval>".to_string())
    } else if let Some(path) = file_path.clone() {
        let fs_path = resolver::file_url_to_path(&path).unwrap_or_else(|| path.clone());
        match std::fs::read_to_string(&fs_path) {
            Ok(content) => (content, path),
            Err(e) => {
                write_to_stream(&stderr, format!("tsx: {}: {}\n", path, e).as_bytes());
                return 1;
            }
        }
    } else {
        match read_all_from_stream(&stdin) {
            Ok(data) => (
                String::from_utf8_lossy(&data).to_string(),
                "<stdin>".to_string(),
            ),
            Err(e) => {
                write_to_stream(
                    &stderr,
                    format!("tsx: failed to read stdin: {}\n", e).as_bytes(),
                );
                return 1;
            }
        }
    };

    if ts_code.is_empty() {
        write_to_stream(&stderr, b"tsx: no code to execute\n");
        return 1;
    }

    // Step 1: Transpile TypeScript to JavaScript
    // The transpiler now handles everything at AST level:
    // - Type stripping
    // - AwaitLastExpr transform (await last expression for Promise capture)
    // - WrapInAsyncIife transform (async IIFE with error handling)
    // - Source map generation (for accurate error line numbers)
    let transpile_result = match transpiler::transpile(&ts_code) {
        Ok(result) => result,
        Err(e) => {
            write_to_stream(&stderr, format!("tsx: transpile error: {}\n", e).as_bytes());
            return 1;
        }
    };

    // Step 2: Execute the JavaScript using QuickJS with full runtime
    // Clear any captured logs from previous executions
    js_modules::console::clear_logs();
    js_modules::process::set_argv(script_args);
    js_modules::process::set_runtime_env(env.cwd, env.vars);

    // TODO: Use transpile_result.source_map for error line mapping when implemented
    let exec_result = if transpile_result.contains_module_decls {
        execute_js_module_with_source_map(
            &transpile_result.code,
            &source_name,
            transpile_result.line_map.as_deref(),
            transpile_result.source_map.as_deref(),
        )
    } else {
        execute_js_with_source_map(
            &transpile_result.code,
            &source_name,
            transpile_result.line_map.as_deref(),
            transpile_result.source_map.as_deref(),
        )
    };

    js_modules::process::set_argv(Vec::new());
    js_modules::process::set_runtime_env("/".to_string(), Vec::new());

    match exec_result {
        Ok(output) => {
            // First, write any captured console.log output to stdout
            let console_output = js_modules::console::get_logs();
            if !console_output.is_empty() {
                write_to_stream(&stdout, console_output.as_bytes());
                if !console_output.ends_with('\n') {
                    write_to_stream(&stdout, b"\n");
                }
            }

            // Then write the expression result if it's meaningful
            // Skip "undefined", "[object]" (Promise from async IIFE), and empty strings
            if !output.is_empty() && output != "undefined" && output != "[object]" {
                write_to_stream(&stdout, output.as_bytes());
                if !output.ends_with('\n') {
                    write_to_stream(&stdout, b"\n");
                }
            }
            0
        }
        Err(e) => {
            // Still write any console output before the error
            let console_output = js_modules::console::get_logs();
            if !console_output.is_empty() {
                write_to_stream(&stdout, console_output.as_bytes());
                if !console_output.ends_with('\n') {
                    write_to_stream(&stdout, b"\n");
                }
            }
            write_to_stream(&stderr, format!("tsx: {}\n", e).as_bytes());
            1
        }
    }
}

/// Transpile-only TypeScript (output JavaScript, no execution)
fn run_tsc(
    args: Vec<String>,
    stdin: InputStream,
    stdout: OutputStream,
    stderr: OutputStream,
) -> i32 {
    // Parse arguments
    let mut code: Option<String> = None;
    let mut file_path: Option<String> = None;
    let mut i = 0;

    while i < args.len() {
        match args[i].as_str() {
            "-e" | "--eval" => {
                if i + 1 < args.len() {
                    code = Some(args[i + 1].clone());
                    i += 2;
                } else {
                    write_to_stream(&stderr, b"tsc: -e requires an argument\n");
                    return 1;
                }
            }
            "-h" | "--help" => {
                write_to_stream(&stdout, b"Usage: tsc [options] [file]\n");
                write_to_stream(&stdout, b"  -e, --eval <code>  Transpile inline code\n");
                write_to_stream(&stdout, b"  -h, --help         Show this help\n");
                write_to_stream(
                    &stdout,
                    b"\nTranspiles TypeScript to JavaScript (no execution).\n",
                );
                return 0;
            }
            arg if !arg.starts_with('-') => {
                file_path = Some(arg.to_string());
                i += 1;
            }
            _ => {
                write_to_stream(
                    &stderr,
                    format!("tsc: unknown option: {}\n", args[i]).as_bytes(),
                );
                return 1;
            }
        }
    }

    // Get TypeScript code
    let ts_code = if let Some(c) = code {
        c
    } else if let Some(path) = file_path {
        match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(e) => {
                write_to_stream(&stderr, format!("tsc: {}: {}\n", path, e).as_bytes());
                return 1;
            }
        }
    } else {
        match read_all_from_stream(&stdin) {
            Ok(data) => String::from_utf8_lossy(&data).to_string(),
            Err(e) => {
                write_to_stream(
                    &stderr,
                    format!("tsc: failed to read stdin: {}\n", e).as_bytes(),
                );
                return 1;
            }
        }
    };

    if ts_code.is_empty() {
        write_to_stream(&stderr, b"tsc: no code to transpile\n");
        return 1;
    }

    // Transpile only - output JavaScript
    match transpile(&ts_code) {
        Ok(js_code) => {
            write_to_stream(&stdout, js_code.as_bytes());
            if !js_code.ends_with('\n') {
                write_to_stream(&stdout, b"\n");
            }
            0
        }
        Err(e) => {
            write_to_stream(&stderr, format!("tsc: transpile error: {}\n", e).as_bytes());
            1
        }
    }
}

/// Transpile TypeScript to JavaScript using the transpiler module (code only, no IIFE)
fn transpile(ts_code: &str) -> Result<String, String> {
    transpiler::transpile_code_only(ts_code)
}

/// Execute JavaScript using QuickJS with full Node.js-like runtime
#[cfg(test)]
fn execute_js(
    js_code: &str,
    source_name: &str,
    line_map: Option<&[usize]>,
) -> Result<String, String> {
    execute_js_with_source_map(js_code, source_name, line_map, None)
}

fn execute_js_with_source_map(
    js_code: &str,
    source_name: &str,
    line_map: Option<&[usize]>,
    source_map: Option<&[u8]>,
) -> Result<String, String> {
    execute_js_with_source_map_and_limits(
        js_code,
        source_name,
        line_map,
        source_map,
        DEFAULT_RUNTIME_LIMITS,
    )
}

fn execute_js_with_source_map_and_limits(
    js_code: &str,
    source_name: &str,
    line_map: Option<&[usize]>,
    source_map: Option<&[u8]>,
    limits: RuntimeLimits,
) -> Result<String, String> {
    let runtime = AsyncRuntime::new().map_err(|e| format!("Failed to create runtime: {}", e))?;
    configure_runtime_with_limits(&runtime, limits);
    let context = futures_lite::future::block_on(AsyncContext::full(&runtime))
        .map_err(|e| format!("Failed to create context: {}", e))?;

    // Install all JS modules (console, fs, path, Buffer, fetch, etc.)
    futures_lite::future::block_on(context.with(|ctx| {
        js_modules::install_all(&ctx)?;
        let escaped = source_name.replace('\\', "\\\\").replace('\'', "\\'");
        let bootstrap = format!(
            "globalThis.__tsxEntryBase = '{}'; \
             if (globalThis.__tsxCreateRequire) {{ globalThis.require = globalThis.__tsxCreateRequire(globalThis.__tsxEntryBase); }} \
             if (globalThis.__dirname !== undefined) {{ \
               const p = globalThis.__tsxEntryBase || '/'; \
               const i = p.lastIndexOf('/'); \
               globalThis.__filename = p; \
               globalThis.__dirname = i > 0 ? p.slice(0, i) : '/'; \
             }}",
            escaped
        );
        ctx.eval::<(), _>(bootstrap)?;
        Ok::<(), rquickjs::Error>(())
    }))
    .map_err(|e| format!("Failed to install bindings: {}", e))?;

    // Set up the resolver and loader for module imports
    futures_lite::future::block_on(
        runtime.set_loader(resolver::HybridResolver, loader::HybridLoader),
    );

    // Execute the code
    let result = futures_lite::future::block_on(context.with(|ctx| {
        let mut options = EvalOptions::default();
        options.filename = Some(source_name.to_string());
        let result: Result<rquickjs::Value, _> = ctx.eval_with_options(js_code, options);
        match result.catch(&ctx) {
            Ok(val) => Ok(format_js_value(&ctx, val)),
            Err(e) => Err(format_js_error(&ctx, e, source_name, line_map, source_map)),
        }
    }));

    // Drive the event loop to completion to resolve any pending Promises
    // This ensures console.log calls inside async code are captured
    futures_lite::future::block_on(runtime.idle());

    if result.is_ok() {
        if let Some(raw_err) = take_unhandled_error(&context) {
            return Err(format_js_unhandled_error(
                source_name,
                line_map,
                source_map,
                &raw_err,
            ));
        }
    }

    result
}

/// Execute module JavaScript by writing it to a temporary file and importing it.
#[cfg(test)]
fn execute_js_module(
    js_code: &str,
    source_name: &str,
    line_map: Option<&[usize]>,
) -> Result<String, String> {
    execute_js_module_with_source_map(js_code, source_name, line_map, None)
}

fn execute_js_module_with_source_map(
    js_code: &str,
    source_name: &str,
    line_map: Option<&[usize]>,
    source_map: Option<&[u8]>,
) -> Result<String, String> {
    execute_js_module_with_source_map_and_limits(
        js_code,
        source_name,
        line_map,
        source_map,
        DEFAULT_RUNTIME_LIMITS,
    )
}

fn execute_js_module_with_source_map_and_limits(
    js_code: &str,
    source_name: &str,
    line_map: Option<&[usize]>,
    source_map: Option<&[u8]>,
    limits: RuntimeLimits,
) -> Result<String, String> {
    let runtime = AsyncRuntime::new().map_err(|e| format!("Failed to create runtime: {}", e))?;
    configure_runtime_with_limits(&runtime, limits);
    let context = futures_lite::future::block_on(AsyncContext::full(&runtime))
        .map_err(|e| format!("Failed to create context: {}", e))?;

    futures_lite::future::block_on(context.with(|ctx| {
        js_modules::install_all(&ctx)?;
        let escaped = source_name.replace('\\', "\\\\").replace('\'', "\\'");
        let bootstrap = format!(
            "globalThis.__tsxEntryBase = '{}'; \
             if (globalThis.__tsxCreateRequire) {{ globalThis.require = globalThis.__tsxCreateRequire(globalThis.__tsxEntryBase); }} \
             if (globalThis.__dirname !== undefined) {{ \
               const p = globalThis.__tsxEntryBase || '/'; \
               const i = p.lastIndexOf('/'); \
               globalThis.__filename = p; \
               globalThis.__dirname = i > 0 ? p.slice(0, i) : '/'; \
             }}",
            escaped
        );
        ctx.eval::<(), _>(bootstrap)?;
        Ok::<(), rquickjs::Error>(())
    }))
    .map_err(|e| format!("Failed to install bindings: {}", e))?;

    futures_lite::future::block_on(
        runtime.set_loader(resolver::HybridResolver, loader::HybridLoader),
    );

    let temp_name = temp_module_path(source_name);
    std::fs::write(&temp_name, js_code)
        .map_err(|e| format!("Failed to write module {}: {}", temp_name, e))?;
    let escaped_path = temp_name.replace('\\', "\\\\").replace('\'', "\\'");
    let bootstrap = format!(
        "globalThis.__tsxModuleDefault = undefined;\n\
         globalThis.__tsxModuleError = undefined;\n\
         import('{}')\n\
           .then((m) => {{ globalThis.__tsxModuleDefault = (m && m.default); }})\n\
           .catch((e) => {{ globalThis.__tsxModuleError = e; }});\n\
         undefined;",
        escaped_path
    );

    let eval_result = futures_lite::future::block_on(context.with(|ctx| {
        let result: Result<rquickjs::Value, _> = ctx.eval(bootstrap);
        match result.catch(&ctx) {
            Ok(_) => Ok(()),
            Err(e) => Err(format_js_error(&ctx, e, source_name, line_map, source_map)),
        }
    }));
    if let Err(e) = eval_result {
        let _ = std::fs::remove_file(&temp_name);
        return Err(e);
    }

    futures_lite::future::block_on(runtime.idle());

    let result = futures_lite::future::block_on(context.with(|ctx| {
        let globals = ctx.globals();
        let module_error: rquickjs::Value = globals
            .get("__tsxModuleError")
            .map_err(|e| format!("Error in {}: {:?}", source_name, e))?;
        if !module_error.is_undefined() && !module_error.is_null() {
            return Err(format!(
                "Error in {}: module import failed: {:?}",
                source_name, module_error
            ));
        }
        let default_value: rquickjs::Value = globals
            .get("__tsxModuleDefault")
            .map_err(|e| format!("Error in {}: {:?}", source_name, e))?;
        Ok(format_js_value(&ctx, default_value))
    }));

    let _ = std::fs::remove_file(&temp_name);
    if result.is_ok() {
        if let Some(raw_err) = take_unhandled_error(&context) {
            return Err(format_js_unhandled_error(
                source_name,
                line_map,
                source_map,
                &raw_err,
            ));
        }
    }
    result
}

fn configure_runtime_with_limits(runtime: &AsyncRuntime, limits: RuntimeLimits) {
    let started_at = Instant::now();
    futures_lite::future::block_on(async {
        runtime.set_memory_limit(limits.memory_limit_bytes).await;
        runtime.set_max_stack_size(limits.max_stack_bytes).await;
        runtime.set_gc_threshold(limits.gc_threshold_bytes).await;

        runtime
            .set_interrupt_handler(Some(Box::new(move || {
                started_at.elapsed() >= limits.execution_timeout
            })))
            .await;

        runtime
            .set_host_promise_rejection_tracker(Some(Box::new(
                |ctx, promise, reason, is_handled| {
                    let globals = ctx.globals();
                    if is_handled {
                        let previous: rquickjs::Value = globals
                            .get("__lastUnhandledPromise")
                            .unwrap_or_else(|_| rquickjs::Value::new_null(ctx.clone()));
                        if !previous.is_null() && previous == promise {
                            let _ = globals.set(
                                "__lastUnhandledPromise",
                                rquickjs::Value::new_null(ctx.clone()),
                            );
                            let _ = globals.set(
                                "__lastUnhandledError",
                                rquickjs::Value::new_null(ctx.clone()),
                            );
                        }
                        return;
                    }
                    let _ = globals.set("__lastUnhandledPromise", promise);
                    let _ = globals.set("__lastUnhandledError", reason);
                },
            )))
            .await;
    });
}

fn take_unhandled_error(context: &AsyncContext) -> Option<String> {
    futures_lite::future::block_on(context.with(|ctx| {
        let globals = ctx.globals();
        let val: rquickjs::Value = globals
            .get("__lastUnhandledError")
            .unwrap_or_else(|_| rquickjs::Value::new_null(ctx.clone()));
        if val.is_null() || val.is_undefined() {
            return None;
        }
        // Clear after reading so subsequent runs do not inherit stale state.
        let _ = globals.set(
            "__lastUnhandledError",
            rquickjs::Value::new_null(ctx.clone()),
        );
        let _ = globals.set(
            "__lastUnhandledPromise",
            rquickjs::Value::new_null(ctx.clone()),
        );
        Some(format!("{:?}", val))
    }))
}

fn temp_module_path(source_name: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    if source_name.starts_with('<') {
        return format!("/tmp/tsx-entry-{}.mjs", nanos);
    }
    let source_local =
        resolver::file_url_to_path(source_name).unwrap_or_else(|| source_name.to_string());
    let source_path = std::path::Path::new(&source_local);
    if let Some(parent) = source_path.parent() {
        if parent.exists() {
            return parent
                .join(format!(".__tsx_entry_{}.mjs", nanos))
                .to_string_lossy()
                .to_string();
        }
    }
    format!("/tmp/tsx-entry-{}.mjs", nanos)
}

/// Format a JavaScript value for output
fn format_js_value<'a>(_ctx: &rquickjs::Ctx<'a>, val: rquickjs::Value<'a>) -> String {
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
    } else if val.is_object() || val.is_array() {
        // Try JSON.stringify
        "[object]".to_string()
    } else {
        "[value]".to_string()
    }
}

/// Format a JavaScript error with source context
fn format_js_error<'a>(
    _ctx: &rquickjs::Ctx<'a>,
    err: rquickjs::CaughtError<'a>,
    source_name: &str,
    line_map: Option<&[usize]>,
    source_map: Option<&[u8]>,
) -> String {
    let raw = format!("{:?}", err);
    let (remapped_raw, first_mapping) = remap_error_positions(&raw, line_map, source_map);
    if let Some((generated_line, mapped_line, mapped_col)) = first_mapping {
        return format!(
            "Error in {}:{}:{} (mapped from generated line {}): {}",
            source_name, mapped_line, mapped_col, generated_line, remapped_raw
        );
    }
    format!("Error in {}: {}", source_name, remapped_raw)
}

fn map_generated_position(
    generated_line_1: usize,
    generated_col_1: usize,
    line_map: Option<&[usize]>,
    source_map: Option<&[u8]>,
) -> Option<(usize, usize)> {
    if let Some(sm_bytes) = source_map {
        if let Ok(sm) = swc_sourcemap::SourceMap::from_slice(sm_bytes) {
            let line0 = generated_line_1.saturating_sub(1) as u32;
            let col0 = generated_col_1.saturating_sub(1) as u32;
            if let Some(token) = sm.lookup_token(line0, col0) {
                if token.has_source() {
                    let mapped_line = token.get_src_line() as usize + 1;
                    let mapped_col = token.get_src_col() as usize + 1;
                    return Some((mapped_line, mapped_col));
                }
            }
        }
    }
    if let Some(map) = line_map {
        let mapped_line = if generated_line_1 > 0 && generated_line_1 <= map.len() {
            map[generated_line_1 - 1]
        } else {
            generated_line_1
        };
        return Some((mapped_line, generated_col_1));
    }
    None
}

fn remap_error_positions(
    raw: &str,
    line_map: Option<&[usize]>,
    source_map: Option<&[u8]>,
) -> (String, Option<(usize, usize, usize)>) {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut last_emit = 0usize;
    let mut i = 0usize;
    let mut first_mapping: Option<(usize, usize, usize)> = None;

    while i < bytes.len() {
        if bytes[i] != b':' {
            i += 1;
            continue;
        }
        let line_start = i + 1;
        let mut j = line_start;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j == line_start || j >= bytes.len() || bytes[j] != b':' {
            i += 1;
            continue;
        }
        let col_start = j + 1;
        let mut k = col_start;
        while k < bytes.len() && bytes[k].is_ascii_digit() {
            k += 1;
        }
        if k == col_start {
            i += 1;
            continue;
        }

        let generated_line = match raw[line_start..j].parse::<usize>() {
            Ok(v) => v,
            Err(_) => {
                i += 1;
                continue;
            }
        };
        let generated_col = match raw[col_start..k].parse::<usize>() {
            Ok(v) => v,
            Err(_) => {
                i += 1;
                continue;
            }
        };

        if !is_likely_stack_location(raw, i) {
            i = k;
            continue;
        }

        if let Some((mapped_line, mapped_col)) =
            map_generated_position(generated_line, generated_col, line_map, source_map)
        {
            out.push_str(&raw[last_emit..i]);
            out.push(':');
            out.push_str(&mapped_line.to_string());
            out.push(':');
            out.push_str(&mapped_col.to_string());
            last_emit = k;

            if first_mapping.is_none() {
                first_mapping = Some((generated_line, mapped_line, mapped_col));
            }
        }

        i = k;
    }

    if last_emit == 0 {
        return (raw.to_string(), first_mapping);
    }
    out.push_str(&raw[last_emit..]);
    (out, first_mapping)
}

fn is_likely_stack_location(raw: &str, first_colon_idx: usize) -> bool {
    if first_colon_idx == 0 || first_colon_idx > raw.len() {
        return false;
    }
    let bytes = raw.as_bytes();
    let mut start = first_colon_idx;
    while start > 0 {
        let b = bytes[start - 1];
        if b.is_ascii_whitespace() || b == b'(' || b == b'[' || b == b'"' || b == b'\'' {
            break;
        }
        start -= 1;
    }
    if start >= first_colon_idx {
        return false;
    }
    let seg = &raw[start..first_colon_idx];
    let segment = seg.trim();
    if segment.is_empty() {
        return false;
    }
    if segment.starts_with('<') && segment.ends_with('>') {
        return true;
    }
    if !(segment.contains('/') || segment.contains('\\') || segment.contains('.')) {
        return false;
    }
    [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]
        .iter()
        .any(|ext| segment.contains(ext))
}

fn format_js_unhandled_error(
    source_name: &str,
    line_map: Option<&[usize]>,
    source_map: Option<&[u8]>,
    raw: &str,
) -> String {
    let (remapped_raw, first_mapping) = remap_error_positions(raw, line_map, source_map);
    if let Some((generated_line, mapped_line, mapped_col)) = first_mapping {
        return format!(
            "Unhandled error in {}:{}:{} (mapped from generated line {}): {}",
            source_name, mapped_line, mapped_col, generated_line, remapped_raw
        );
    }
    format!("Unhandled error in {}: {}", source_name, remapped_raw)
}

/// Helper to write data to an output stream
fn write_to_stream(stream: &OutputStream, data: &[u8]) {
    let _ = stream.blocking_write_and_flush(data);
}

/// Helper to read all data from an input stream
fn read_all_from_stream(stream: &InputStream) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    loop {
        match stream.blocking_read(4096) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    break;
                }
                result.extend_from_slice(&chunk);
            }
            Err(e) => {
                return Err(format!("stream read failed: {:?}", e));
            }
        }
    }
    Ok(result)
}

bindings::export!(TsxEngine with_types_in bindings);

#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path(name: &str, ext: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("/tmp/tsx-engine-{}-{}.{}", name, nanos, ext)
    }

    #[test]
    fn test_integration_script_mode_runs_async_and_captures_console() {
        let ts = r#"
            async function main() {
                console.log("script-ok");
                return 7;
            }
            main();
        "#;

        let transpiled = transpiler::transpile(ts).unwrap();
        assert!(!transpiled.contains_module_decls);

        js_modules::console::clear_logs();
        let output = execute_js(
            &transpiled.code,
            "<integration-script>",
            transpiled.line_map.as_deref(),
        )
        .unwrap();

        // Script mode commonly returns promise/object marker; console side effects are critical.
        assert!(!output.is_empty());
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("script-ok"), "logs: {}", logs);
    }

    #[test]
    fn test_integration_module_mode_imports_typescript_dependency() {
        let dep_path = unique_temp_path("dep", "ts");
        let entry_ts = format!(
            "import {{ value }} from './{}';\nconsole.log(value + 1);\nexport default value + 1;",
            dep_path.rsplit('/').next().unwrap_or("dep.ts")
        );
        let entry_dir = dep_path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .unwrap_or_else(|| "/tmp".to_string());
        let entry_path = format!("{}/entry.ts", entry_dir);

        std::fs::write(&dep_path, "export const value: number = 41;").unwrap();
        std::fs::write(&entry_path, entry_ts).unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(transpiled.contains_module_decls);

        js_modules::console::clear_logs();
        let output = execute_js_module(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();

        assert_eq!(output, "42");
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("42"), "logs: {}", logs);

        let _ = std::fs::remove_file(&dep_path);
        let _ = std::fs::remove_file(&entry_path);
    }

    #[test]
    fn test_integration_module_mode_imports_json_with_attributes() {
        let root = unique_temp_path("json-attrs", "dir");
        let _ = std::fs::create_dir_all(&root);
        let json_path = format!("{}/data.json", root);
        std::fs::write(&json_path, r#"{"value":41}"#).unwrap();
        let source_name = format!("{}/entry.ts", root);
        let js =
            "import data from './data.json' with { type: 'json' }; export default data.value + 1;";

        let output = execute_js_module(js, &source_name, None).unwrap();
        assert_eq!(output, "42");

        let _ = std::fs::remove_file(&json_path);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_reads_process_argv() {
        let ts = "export default process.argv.slice(2).join(',');";
        let transpiled = transpiler::transpile(ts).unwrap();
        assert!(transpiled.contains_module_decls);

        js_modules::process::set_argv(vec!["--mode".to_string(), "agent".to_string()]);
        let output = execute_js_module(
            &transpiled.code,
            "<integration-argv>",
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        js_modules::process::set_argv(Vec::new());

        assert_eq!(output, "--mode,agent");
    }

    #[test]
    fn test_integration_module_mode_resolves_node_modules_exports() {
        let root = unique_temp_path("pkg-exports", "dir");
        let src_dir = format!("{}/src", root);
        let pkg_dir = format!("{}/node_modules/foo", root);
        let dist_dir = format!("{}/dist", pkg_dir);
        let _ = std::fs::create_dir_all(&src_dir);
        let _ = std::fs::create_dir_all(&dist_dir);

        let entry_path = format!("{}/entry.ts", src_dir);
        std::fs::write(
            format!("{}/package.json", pkg_dir),
            r#"{"name":"foo","exports":{"." :"./dist/index.js"}}"#,
        )
        .unwrap();
        std::fs::write(
            format!("{}/index.js", dist_dir),
            "export const fooValue = 41;",
        )
        .unwrap();
        std::fs::write(
            &entry_path,
            "import { fooValue } from 'foo'; export default fooValue + 1;",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(transpiled.contains_module_decls);

        let output = execute_js_module(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        assert_eq!(output, "42");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_resolves_package_imports_alias() {
        let root = unique_temp_path("pkg-imports", "dir");
        let src_dir = format!("{}/src", root);
        let _ = std::fs::create_dir_all(&src_dir);
        let entry_path = format!("{}/entry.ts", src_dir);
        let lib_path = format!("{}/lib.ts", src_dir);

        std::fs::write(
            format!("{}/package.json", root),
            r##"{"imports":{"#lib":"./src/lib.ts"}}"##,
        )
        .unwrap();
        std::fs::write(&lib_path, "export const libValue: number = 9;").unwrap();
        std::fs::write(
            &entry_path,
            "import { libValue } from '#lib'; export default libValue * 2;",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(transpiled.contains_module_decls);

        let output = execute_js_module(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        assert_eq!(output, "18");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_resolves_package_imports_wildcard_alias() {
        let root = unique_temp_path("pkg-imports-wildcard", "dir");
        let src_dir = format!("{}/src", root);
        let utils_dir = format!("{}/src/utils", root);
        let _ = std::fs::create_dir_all(&utils_dir);
        let entry_path = format!("{}/entry.ts", src_dir);
        let helper_path = format!("{}/helper.ts", utils_dir);

        std::fs::write(
            format!("{}/package.json", root),
            r##"{"imports":{"#utils/*":"./src/utils/*.ts"}}"##,
        )
        .unwrap();
        std::fs::write(&helper_path, "export const helperValue: number = 5;").unwrap();
        std::fs::write(
            &entry_path,
            "import { helperValue } from '#utils/helper'; export default helperValue + 2;",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(transpiled.contains_module_decls);

        let output = execute_js_module(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        assert_eq!(output, "7");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_resolves_exports_wildcard_subpath() {
        let root = unique_temp_path("pkg-exports-wildcard", "dir");
        let src_dir = format!("{}/src", root);
        let pkg_dir = format!("{}/node_modules/foo", root);
        let dist_dir = format!("{}/dist", pkg_dir);
        let _ = std::fs::create_dir_all(&src_dir);
        let _ = std::fs::create_dir_all(&dist_dir);

        let entry_path = format!("{}/entry.ts", src_dir);
        std::fs::write(
            format!("{}/package.json", pkg_dir),
            r#"{"name":"foo","exports":{"./*":"./dist/*.js"}}"#,
        )
        .unwrap();
        std::fs::write(
            format!("{}/math.js", dist_dir),
            "export const mathValue = 10;",
        )
        .unwrap();
        std::fs::write(
            &entry_path,
            "import { mathValue } from 'foo/math'; export default mathValue + 1;",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(transpiled.contains_module_decls);

        let output = execute_js_module(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        assert_eq!(output, "11");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_cjs_require_local_file_and_json() {
        let root = unique_temp_path("cjs-local", "dir");
        let _ = std::fs::create_dir_all(&root);
        let entry_path = format!("{}/entry.ts", root);
        let cjs_path = format!("{}/helper.cjs", root);
        let json_path = format!("{}/config.json", root);

        std::fs::write(&cjs_path, "module.exports = { value: 4 };").unwrap();
        std::fs::write(&json_path, r#"{"name":"agent","n":3}"#).unwrap();
        std::fs::write(
            &entry_path,
            "const h = require('./helper.cjs'); const cfg = require('./config.json'); console.log(h.value + cfg.n);",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(!transpiled.contains_module_decls);

        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("7"), "logs: {}", logs);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_cjs_require_uses_require_condition_from_exports() {
        let root = unique_temp_path("cjs-exports-cond", "dir");
        let src_dir = format!("{}/src", root);
        let pkg_dir = format!("{}/node_modules/foo", root);
        let dist_dir = format!("{}/dist", pkg_dir);
        let _ = std::fs::create_dir_all(&src_dir);
        let _ = std::fs::create_dir_all(&dist_dir);
        let entry_path = format!("{}/entry.ts", src_dir);

        std::fs::write(
            format!("{}/package.json", pkg_dir),
            r#"{"name":"foo","exports":{"." :{"import":"./dist/esm.js","require":"./dist/cjs.cjs"}}}"#,
        )
        .unwrap();
        std::fs::write(format!("{}/esm.js", dist_dir), "export const kind = 'esm';").unwrap();
        std::fs::write(
            format!("{}/cjs.cjs", dist_dir),
            "module.exports = { kind: 'cjs' };",
        )
        .unwrap();
        std::fs::write(
            &entry_path,
            "const x = require('foo'); console.log(x.kind);",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(!transpiled.contains_module_decls);

        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("cjs"), "logs: {}", logs);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_cjs_require_esm_default_export() {
        let root = unique_temp_path("cjs-require-esm-default", "dir");
        let _ = std::fs::create_dir_all(&root);
        let entry_path = format!("{}/entry.ts", root);
        let esm_path = format!("{}/esm.mjs", root);

        std::fs::write(&esm_path, "export default 41;").unwrap();
        std::fs::write(
            &entry_path,
            "const mod = require('./esm.mjs'); console.log(mod.default + 1);",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(!transpiled.contains_module_decls);

        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("42"), "logs: {}", logs);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_cjs_require_esm_named_export() {
        let root = unique_temp_path("cjs-require-esm-named", "dir");
        let _ = std::fs::create_dir_all(&root);
        let entry_path = format!("{}/entry.ts", root);
        let esm_path = format!("{}/esm.js", root);

        std::fs::write(&esm_path, "export const value = 7;").unwrap();
        std::fs::write(
            &entry_path,
            "const mod = require('./esm.js'); console.log(mod.value + 1);",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(!transpiled.contains_module_decls);

        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("8"), "logs: {}", logs);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_cjs_require_esm_with_import_dependency() {
        let root = unique_temp_path("cjs-require-esm-import-dep", "dir");
        let _ = std::fs::create_dir_all(&root);
        let entry_path = format!("{}/entry.ts", root);
        let esm_path = format!("{}/esm.mjs", root);
        let dep_path = format!("{}/dep.cjs", root);

        std::fs::write(&dep_path, "module.exports = { base: 9 };").unwrap();
        std::fs::write(
            &esm_path,
            "import dep from './dep.cjs'; export const value = dep.base + 1;",
        )
        .unwrap();
        std::fs::write(
            &entry_path,
            "const mod = require('./esm.mjs'); console.log(mod.value);",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(!transpiled.contains_module_decls);

        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("10"), "logs: {}", logs);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_cjs_require_caches_module_once() {
        let root = unique_temp_path("cjs-cache", "dir");
        let _ = std::fs::create_dir_all(&root);
        let entry_path = format!("{}/entry.ts", root);
        let cjs_path = format!("{}/counter.cjs", root);

        std::fs::write(
            &cjs_path,
            "globalThis.__loadCount = (globalThis.__loadCount || 0) + 1; module.exports = { count: globalThis.__loadCount };",
        )
        .unwrap();
        std::fs::write(
            &entry_path,
            "const a = require('./counter.cjs'); const b = require('./counter.cjs'); console.log(String(a.count) + '|' + String(b.count) + '|' + String(globalThis.__loadCount));",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(!transpiled.contains_module_decls);

        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("1|1|1"), "logs: {}", logs);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_supports_file_url_source_name() {
        let root = unique_temp_path("file-url-source", "dir");
        let _ = std::fs::create_dir_all(&root);
        let dep_path = format!("{}/dep.ts", root);
        let entry_path = format!("{}/entry.ts", root);

        std::fs::write(&dep_path, "export const v = 41;").unwrap();
        std::fs::write(
            &entry_path,
            "import { v } from './dep.ts'; export default v + 1;",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(transpiled.contains_module_decls);

        let file_url_source = format!("file://{}", entry_path);
        let output = execute_js_module(
            &transpiled.code,
            &file_url_source,
            transpiled.line_map.as_deref(),
        );
        assert_eq!(output.unwrap(), "42");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_imports_commonjs_default() {
        let root = unique_temp_path("esm-import-cjs-default", "dir");
        let _ = std::fs::create_dir_all(&root);
        let cjs_path = format!("{}/helper.cjs", root);
        let entry_path = format!("{}/entry.ts", root);

        std::fs::write(&cjs_path, "module.exports = { value: 41, label: 'ok' };").unwrap();
        std::fs::write(
            &entry_path,
            "import helper from './helper.cjs'; export default helper.value + 1;",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(transpiled.contains_module_decls);

        let output = execute_js_module(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        );
        assert_eq!(output.unwrap(), "42");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_imports_commonjs_namespace() {
        let root = unique_temp_path("esm-import-cjs-namespace", "dir");
        let _ = std::fs::create_dir_all(&root);
        let cjs_path = format!("{}/helper.cjs", root);
        let entry_path = format!("{}/entry.ts", root);

        std::fs::write(&cjs_path, "module.exports = { value: 7 };").unwrap();
        std::fs::write(
            &entry_path,
            "import * as helperNs from './helper.cjs'; export default helperNs.default.value + 3;",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(transpiled.contains_module_decls);

        let output = execute_js_module(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        );
        assert_eq!(output.unwrap(), "10");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_imports_commonjs_with_top_level_return() {
        let root = unique_temp_path("esm-import-cjs-top-level-return", "dir");
        let _ = std::fs::create_dir_all(&root);
        let cjs_path = format!("{}/helper.cjs", root);
        let entry_path = format!("{}/entry.ts", root);

        std::fs::write(
            &cjs_path,
            "if (true) { module.exports = { value: 5 }; return; }",
        )
        .unwrap();
        std::fs::write(
            &entry_path,
            "import helper from './helper.cjs'; export default helper.value + 1;",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(transpiled.contains_module_decls);

        let output = execute_js_module(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        );
        assert_eq!(output.unwrap(), "6");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_timers_and_immediate_callbacks() {
        let ts = r#"
            let out: string[] = [];
            process.nextTick(() => out.push('nextTick'));
            const tid = setTimeout(() => out.push('timeout'), 0);
            clearTimeout(tid);
            setImmediate(() => out.push('immediate'));
            setTimeout(() => console.log(out.join(',')), 0);
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        js_modules::console::clear_logs();
        let _ = execute_js(&transpiled.code, "<timers>", transpiled.line_map.as_deref()).unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("nextTick"), "logs: {}", logs);
        assert!(logs.contains("immediate"), "logs: {}", logs);
        assert!(!logs.contains("timeout"), "logs: {}", logs);
    }

    #[test]
    fn test_integration_runtime_error_reports_mapped_line() {
        let ts = r#"
            const a = 1;
            const b = 2;
            throw new Error('boom');
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        let err = execute_js(
            &transpiled.code,
            "mapped.ts",
            transpiled.line_map.as_deref(),
        )
        .unwrap_err();
        assert!(err.contains("mapped.ts"), "err: {}", err);
        assert!(err.contains("mapped from generated line"), "err: {}", err);
    }

    #[test]
    fn test_integration_runtime_error_uses_source_map_when_line_map_absent() {
        let ts = r#"
            const a = 1;
            const b = 2;
            throw new Error('boom-sm');
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        let err = execute_js_with_source_map(
            &transpiled.code,
            "mapped-sm.ts",
            None,
            transpiled.source_map.as_deref(),
        )
        .unwrap_err();
        assert!(err.contains("mapped-sm.ts"), "err: {}", err);
        assert!(err.contains("mapped from generated line"), "err: {}", err);
    }

    #[test]
    fn test_error_position_remapper_maps_multiple_occurrences_with_line_map() {
        let raw = "Exception { stack: Some(\"    at first (/tmp/gen.js:2:3)\\n    at second (/tmp/gen.js:4:5)\") }";
        let dense = vec![10usize, 11usize, 12usize, 13usize, 14usize];
        let (remapped, first) = remap_error_positions(raw, Some(&dense), None);

        assert!(
            remapped.contains("/tmp/gen.js:11:3"),
            "remapped: {}",
            remapped
        );
        assert!(
            remapped.contains("/tmp/gen.js:13:5"),
            "remapped: {}",
            remapped
        );
        assert_eq!(first, Some((2, 11, 3)));
    }

    #[test]
    fn test_error_position_remapper_ignores_non_stack_numeric_patterns() {
        let raw = "Error { meta: status:2:3 retry:4:5 }";
        let dense = vec![10usize, 11usize, 12usize, 13usize, 14usize];
        let (remapped, first) = remap_error_positions(raw, Some(&dense), None);
        assert_eq!(remapped, raw);
        assert_eq!(first, None);
    }

    #[test]
    fn test_integration_runtime_error_remaps_multiple_stack_frames() {
        let ts = r#"
            function inner() {
                throw new Error('boom-multi-stack');
            }
            function outer() {
                inner();
            }
            outer();
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        let err = execute_js_with_source_map(
            &transpiled.code,
            "mapped-multi.ts",
            None,
            transpiled.source_map.as_deref(),
        )
        .unwrap_err();

        let count = err.matches("mapped-multi.ts:").count();
        assert!(
            count >= 2,
            "expected >=2 mapped frames, got {} in: {}",
            count,
            err
        );
    }

    #[test]
    fn test_integration_fetch_abort_preflight() {
        let ts = r#"
            async function main() {
                const c = new AbortController();
                c.abort();
                try {
                    await fetch('https://example.com', { signal: c.signal });
                    console.log('unexpected');
                } catch (e) {
                    console.log(String(e).toLowerCase().includes('abort'));
                }
            }
            main();
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            "<fetch-abort>",
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("true"), "logs: {}", logs);
    }

    #[test]
    fn test_integration_fetch_timeout_zero_ms() {
        let ts = r#"
            async function main() {
                try {
                    await fetch('https://example.com', { timeoutMs: 0 });
                    console.log('unexpected');
                } catch (e) {
                    console.log(String(e).toLowerCase().includes('timeout'));
                }
            }
            main();
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            "<fetch-timeout>",
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("true"), "logs: {}", logs);
    }

    #[test]
    fn test_integration_runtime_interrupt_timeout_triggers_error() {
        let ts = "while (true) {}";
        let transpiled = transpiler::transpile(ts).unwrap();
        let limits = RuntimeLimits {
            execution_timeout: Duration::from_millis(25),
            ..DEFAULT_RUNTIME_LIMITS
        };
        let err = execute_js_with_source_map_and_limits(
            &transpiled.code,
            "<timeout-limit>",
            transpiled.line_map.as_deref(),
            transpiled.source_map.as_deref(),
            limits,
        )
        .unwrap_err();
        let lower = err.to_lowercase();
        assert!(
            lower.contains("interrupt") || lower.contains("timeout"),
            "err: {}",
            err
        );
    }

    #[test]
    fn test_integration_runtime_memory_limit_is_enforced() {
        let ts = r#"
            const chunk = 'x'.repeat(1024 * 1024);
            console.log(chunk.length);
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        let limits = RuntimeLimits {
            memory_limit_bytes: 256 * 1024,
            execution_timeout: Duration::from_secs(2),
            ..DEFAULT_RUNTIME_LIMITS
        };
        let err = execute_js_with_source_map_and_limits(
            &transpiled.code,
            "<memory-limit>",
            transpiled.line_map.as_deref(),
            transpiled.source_map.as_deref(),
            limits,
        )
        .unwrap_err();
        let lower = err.to_lowercase();
        assert!(
            lower.contains("memory")
                || lower.contains("out of memory")
                || lower.contains("failed to install bindings")
                || lower.contains("exception generated by quickjs"),
            "err: {}",
            err
        );
    }

    #[test]
    fn test_integration_runtime_stack_limit_is_enforced() {
        let ts = r#"
            function recurse() { return recurse() + 1; }
            recurse();
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        let limits = RuntimeLimits {
            max_stack_bytes: 128 * 1024,
            execution_timeout: Duration::from_secs(5),
            ..DEFAULT_RUNTIME_LIMITS
        };
        let err = execute_js_with_source_map_and_limits(
            &transpiled.code,
            "<stack-limit>",
            transpiled.line_map.as_deref(),
            transpiled.source_map.as_deref(),
            limits,
        )
        .unwrap_err();
        let lower = err.to_lowercase();
        assert!(
            lower.contains("stack")
                || lower.contains("recursion")
                || lower.contains("failed to install bindings")
                || lower.contains("exception generated by quickjs"),
            "err: {}",
            err
        );
    }

    #[test]
    fn test_integration_unhandled_rejection_clears_when_later_handled() {
        let ts = r#"
            const p = Promise.reject(new Error('late-handled'));
            Promise.resolve().then(() => p.catch(() => {}));
            setTimeout(() => console.log('handled-later-ok'), 0);
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            "<late-handled>",
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("handled-later-ok"), "logs: {}", logs);
    }

    #[test]
    fn test_integration_multiple_unhandled_rejections_surface_error() {
        let ts = r#"
            Promise.reject('first-unhandled');
            Promise.resolve().then(() => Promise.reject('second-unhandled'));
        "#;
        let transpiled = transpiler::transpile(ts).unwrap();
        let err = execute_js(
            &transpiled.code,
            "<multi-unhandled>",
            transpiled.line_map.as_deref(),
        )
        .unwrap_err();
        assert!(err.contains("Unhandled error"), "err: {}", err);
        assert!(
            err.contains("first-unhandled") || err.contains("second-unhandled"),
            "err: {}",
            err
        );
    }

    #[test]
    fn test_integration_module_mode_rejects_unknown_import_attribute_type() {
        let root = unique_temp_path("json-attrs-unknown", "dir");
        let _ = std::fs::create_dir_all(&root);
        let json_path = format!("{}/data.json", root);
        std::fs::write(&json_path, r#"{"value":41}"#).unwrap();
        let source_name = format!("{}/entry.ts", root);
        let js =
            "import data from './data.json' with { type: 'jsonx' }; export default data.value + 1;";

        let err = execute_js_module(js, &source_name, None).unwrap_err();
        assert!(
            err.contains("Unsupported import attribute type: jsonx"),
            "err: {}",
            err
        );

        let _ = std::fs::remove_file(&json_path);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_rejects_invalid_json_import_attribute() {
        let root = unique_temp_path("json-attrs-invalid", "dir");
        let _ = std::fs::create_dir_all(&root);
        let json_path = format!("{}/data.json", root);
        std::fs::write(&json_path, r#"{"value":"#).unwrap();
        let source_name = format!("{}/entry.ts", root);
        let js =
            "import data from './data.json' with { type: 'json' }; export default data.value + 1;";

        let err = execute_js_module(js, &source_name, None).unwrap_err();
        assert!(err.contains("Invalid JSON module"), "err: {}", err);

        let _ = std::fs::remove_file(&json_path);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_json_without_attributes_is_not_supported() {
        let root = unique_temp_path("json-no-attrs", "dir");
        let _ = std::fs::create_dir_all(&root);
        let json_path = format!("{}/data.json", root);
        std::fs::write(&json_path, r#"{"value":41}"#).unwrap();
        let source_name = format!("{}/entry.ts", root);
        let js = "import data from './data.json'; export default data.value + 1;";

        let err = execute_js_module(js, &source_name, None).unwrap_err();
        assert!(
            err.contains("data.json") || err.contains("module import failed"),
            "err: {}",
            err
        );

        let _ = std::fs::remove_file(&json_path);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_integration_module_mode_async_unhandled_rejection_from_dependency_surfaces() {
        let dep_path = unique_temp_path("dep-async-unhandled", "ts");
        let entry_dir = dep_path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .unwrap_or_else(|| "/tmp".to_string());
        let entry_path = format!("{}/entry.ts", entry_dir);
        let dep_name = dep_path
            .rsplit('/')
            .next()
            .unwrap_or("dep-async-unhandled.ts");

        std::fs::write(
            &dep_path,
            "Promise.resolve().then(() => { throw new Error('dep-async-unhandled'); }); export const value: number = 1;",
        )
        .unwrap();
        std::fs::write(
            &entry_path,
            format!(
                "import {{ value }} from './{}'; export default value;",
                dep_name
            ),
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        let err = execute_js_module(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap_err();
        assert!(err.contains("dep-async-unhandled"), "err: {}", err);
        assert!(err.contains(dep_name), "err: {}", err);

        let _ = std::fs::remove_file(&dep_path);
        let _ = std::fs::remove_file(&entry_path);
    }

    #[test]
    fn test_integration_execution_state_isolation_between_runs() {
        let ts_err = "Promise.reject(new Error('isolation-unhandled'));";
        let transpiled_err = transpiler::transpile(ts_err).unwrap();
        let _ = execute_js(
            &transpiled_err.code,
            "<isolation-err>",
            transpiled_err.line_map.as_deref(),
        )
        .unwrap_err();

        let ts_ok = "console.log('isolation-ok');";
        let transpiled_ok = transpiler::transpile(ts_ok).unwrap();
        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled_ok.code,
            "<isolation-ok>",
            transpiled_ok.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("isolation-ok"), "logs: {}", logs);
    }

    #[test]
    fn test_integration_cjs_require_esm_reexport_chain() {
        let root = unique_temp_path("cjs-require-esm-reexport", "dir");
        let _ = std::fs::create_dir_all(&root);
        let entry_path = format!("{}/entry.ts", root);
        let dep_path = format!("{}/dep.mjs", root);
        let reexport_path = format!("{}/reexport.mjs", root);

        std::fs::write(&dep_path, "export default 40; export const named = 2;").unwrap();
        std::fs::write(
            &reexport_path,
            "export { default, named } from './dep.mjs'; export const another = 1;",
        )
        .unwrap();
        std::fs::write(
            &entry_path,
            "const mod = require('./reexport.mjs'); console.log(mod.default + mod.named + mod.another);",
        )
        .unwrap();

        let source = std::fs::read_to_string(&entry_path).unwrap();
        let transpiled = transpiler::transpile(&source).unwrap();
        assert!(!transpiled.contains_module_decls);

        js_modules::console::clear_logs();
        let _ = execute_js(
            &transpiled.code,
            &entry_path,
            transpiled.line_map.as_deref(),
        )
        .unwrap();
        let logs = js_modules::console::get_logs();
        assert!(logs.contains("43"), "logs: {}", logs);

        let _ = std::fs::remove_dir_all(&root);
    }
}
