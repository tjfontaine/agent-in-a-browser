//! Console module - captures output for the host.

use rquickjs::prelude::Rest;
use rquickjs::{Ctx, Function, Object, Result, Value};

// Captured console output logs.
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
        "[object]".to_string()
    } else if val.is_array() {
        "[array]".to_string()
    } else {
        format!("{:?}", val)
    }
}

/// Install console bindings on the global object.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();
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
