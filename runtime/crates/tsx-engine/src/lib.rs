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

// QuickJS runtime for execution
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt};

struct TsxEngine;

impl Guest for TsxEngine {
    fn run(
        name: String,
        args: Vec<String>,
        _env: ExecEnv,
        stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) -> i32 {
        match name.as_str() {
            "tsx" => run_tsx(args, stdin, stdout, stderr),
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
            arg if !arg.starts_with('-') => {
                file_path = Some(arg.to_string());
                i += 1;
            }
            _ => {
                write_to_stream(
                    &stderr,
                    format!("tsx: unknown option: {}\n", args[i]).as_bytes(),
                );
                return 1;
            }
        }
    }

    // Get TypeScript code from -e, file, or stdin
    let (ts_code, source_name) = if let Some(c) = code {
        (c, "<eval>".to_string())
    } else if let Some(path) = file_path.clone() {
        match std::fs::read_to_string(&path) {
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
    let transpiled = match transpile(&ts_code) {
        Ok(js) => js,
        Err(e) => {
            write_to_stream(&stderr, format!("tsx: transpile error: {}\n", e).as_bytes());
            return 1;
        }
    };

    // Step 1.5: Wrap in async IIFE to support top-level await
    // This allows `await` at the top level of eval'd code.
    //
    // IMPORTANT: We capture the result of the last expression and await it if it's a Promise.
    // This handles the pattern: `async function fn() { ... } fn()` where fn() returns a Promise
    // that would otherwise be orphaned (not awaited) and thus never executed by QuickJS's event loop.
    //
    // The wrapper:
    // 1. Uses eval() to get the result of the last expression in user code
    // 2. Checks if result looks like a Promise (has .then method)
    // 3. If so, awaits it to ensure async function bodies complete
    //
    // Note: We escape the transpiled code for embedding in a template string.
    let escaped_code = transpiled
        .replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("${", "\\${");
    let js_code = format!(
        r#"(async () => {{
const __result__ = eval(`{}`);
if (__result__ && typeof __result__.then === 'function') {{
    await __result__;
}}
}})().catch(e => {{ throw e; }})"#,
        escaped_code
    );

    // Step 2: Execute the JavaScript using QuickJS with full runtime
    // Clear any captured logs from previous executions
    js_modules::console::clear_logs();

    match execute_js(&js_code, &source_name, &stdout, &stderr) {
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

/// Transpile TypeScript to JavaScript using the transpiler module
fn transpile(ts_code: &str) -> Result<String, String> {
    transpiler::transpile(ts_code)
}

/// Execute JavaScript using QuickJS with full Node.js-like runtime
fn execute_js(
    js_code: &str,
    source_name: &str,
    _stdout: &OutputStream,
    _stderr: &OutputStream,
) -> Result<String, String> {
    let runtime = AsyncRuntime::new().map_err(|e| format!("Failed to create runtime: {}", e))?;
    let context = futures_lite::future::block_on(AsyncContext::full(&runtime))
        .map_err(|e| format!("Failed to create context: {}", e))?;

    // Install all JS modules (console, fs, path, Buffer, fetch, etc.)
    futures_lite::future::block_on(context.with(|ctx| {
        js_modules::install_all(&ctx)?;
        Ok::<(), rquickjs::Error>(())
    }))
    .map_err(|e| format!("Failed to install bindings: {}", e))?;

    // Set up the resolver and loader for module imports
    futures_lite::future::block_on(
        runtime.set_loader(resolver::HybridResolver, loader::HybridLoader),
    );

    // Execute the code
    let result = futures_lite::future::block_on(context.with(|ctx| {
        let result: Result<rquickjs::Value, _> = ctx.eval(js_code);
        match result.catch(&ctx) {
            Ok(val) => Ok(format_js_value(&ctx, val)),
            Err(e) => Err(format_js_error(&ctx, e, source_name)),
        }
    }));

    // Drive the event loop to completion to resolve any pending Promises
    // This ensures console.log calls inside async code are captured
    futures_lite::future::block_on(runtime.idle());

    result
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
) -> String {
    format!("Error in {}: {:?}", source_name, err)
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
            Err(_) => break,
        }
    }
    Ok(result)
}

bindings::export!(TsxEngine with_types_in bindings);
