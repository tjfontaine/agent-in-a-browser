//! Process module - Node.js process global shim.
//!
//! Provides process.argv, process.env, process.exit, etc.

use rquickjs::{Ctx, Object, Result};

// Embedded JS shim for process object
const PROCESS_JS: &str = include_str!("shims/process.js");

// Thread-local storage for argv passed to the script
thread_local! {
    static SCRIPT_ARGV: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
}

/// Set the argv for the current script execution
#[allow(dead_code)]
pub fn set_argv(args: Vec<String>) {
    SCRIPT_ARGV.with(|a| {
        *a.borrow_mut() = args;
    });
}

/// Get the current argv
pub fn get_argv() -> Vec<String> {
    SCRIPT_ARGV.with(|a| a.borrow().clone())
}

/// Install process module on the global object.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();

    // Create process object
    let process = Object::new(ctx.clone())?;

    // Set up argv array (will be populated by JS shim)
    let argv = rquickjs::Array::new(ctx.clone())?;

    // argv[0] is typically the executable name
    argv.set(0, "tsx")?;
    // argv[1] is typically the script name
    argv.set(1, "script.ts")?;

    // Add any additional args from thread-local storage
    let extra_args = get_argv();
    for (i, arg) in extra_args.iter().enumerate() {
        argv.set(i + 2, arg.as_str())?;
    }

    process.set("argv", argv)?;

    // Set up env object (empty for now, could be populated from WASI env)
    let env = Object::new(ctx.clone())?;
    process.set("env", env)?;

    // Set up platform and version
    process.set("platform", "wasm")?;
    process.set("version", "v20.0.0")?;

    // Install on globalThis
    globals.set("process", process)?;

    // Evaluate JS shim for additional functionality
    ctx.eval::<(), _>(PROCESS_JS)?;

    Ok(())
}
