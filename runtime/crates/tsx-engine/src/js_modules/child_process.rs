//! Child process module - bridges to shell engine for command execution.
//!
//! For native (non-WASM) builds, uses std::process::Command.
//! For WASM builds, falls back to stub that throws (until WIT import is added).

use rquickjs::{Ctx, Function, Result};

const CHILD_PROCESS_JS: &str = include_str!("shims/child_process.js");

/// Install child_process module and register as a built-in.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    // Expose Rust-side shell execution bridge
    let globals = ctx.globals();

    let shell_exec = Function::new(
        ctx.clone(),
        |cmd: String,
         cwd: Option<String>,
         env_json: Option<String>,
         stdin_data: Option<String>|
         -> String {
            exec_bridge(
                &cmd,
                cwd.as_deref(),
                env_json.as_deref(),
                stdin_data.as_deref(),
            )
        },
    )?;
    globals.set("__tsxShellExec__", shell_exec)?;

    ctx.eval::<(), _>(CHILD_PROCESS_JS)?;
    Ok(())
}

/// Execute a shell command and return JSON: {"code": N, "stdout": "...", "stderr": "..."}
fn exec_bridge(
    cmd: &str,
    cwd: Option<&str>,
    env_json: Option<&str>,
    stdin_data: Option<&str>,
) -> String {
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::process::Command;

        let shell = if cfg!(target_os = "windows") {
            "cmd"
        } else {
            "/bin/sh"
        };
        let shell_arg = if cfg!(target_os = "windows") {
            "/C"
        } else {
            "-c"
        };

        let mut command = Command::new(shell);
        command.arg(shell_arg).arg(cmd);

        if let Some(dir) = cwd {
            command.current_dir(dir);
        }

        // Parse and apply environment variables
        if let Some(json) = env_json {
            if let Ok(vars) =
                serde_json::from_str::<std::collections::HashMap<String, String>>(json)
            {
                for (k, v) in vars {
                    command.env(k, v);
                }
            }
        }

        // Provide stdin data if any
        if stdin_data.is_some() {
            command.stdin(std::process::Stdio::piped());
        }

        let output = if let Some(input) = stdin_data {
            use std::io::Write;
            let mut child = match command
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    return format!(
                        r#"{{"code":1,"stdout":"","stderr":"{}"}}"#,
                        escape_json_string(&e.to_string())
                    );
                }
            };
            if let Some(ref mut stdin_pipe) = child.stdin {
                let _ = stdin_pipe.write_all(input.as_bytes());
            }
            // Close stdin by dropping it
            drop(child.stdin.take());
            match child.wait_with_output() {
                Ok(o) => o,
                Err(e) => {
                    return format!(
                        r#"{{"code":1,"stdout":"","stderr":"{}"}}"#,
                        escape_json_string(&e.to_string())
                    );
                }
            }
        } else {
            match command.output() {
                Ok(o) => o,
                Err(e) => {
                    return format!(
                        r#"{{"code":1,"stdout":"","stderr":"{}"}}"#,
                        escape_json_string(&e.to_string())
                    );
                }
            }
        };

        let code = output.status.code().unwrap_or(1);
        let stdout_str = String::from_utf8_lossy(&output.stdout);
        let stderr_str = String::from_utf8_lossy(&output.stderr);

        format!(
            r#"{{"code":{},"stdout":"{}","stderr":"{}"}}"#,
            code,
            escape_json_string(&stdout_str),
            escape_json_string(&stderr_str)
        )
    }

    #[cfg(target_arch = "wasm32")]
    {
        let _ = (cmd, cwd, env_json, stdin_data);
        r#"{"code":127,"stdout":"","stderr":"child_process: shell execution not available in WASM"}"#
            .to_string()
    }
}

/// Escape a string for JSON embedding
#[cfg(not(target_arch = "wasm32"))]
fn escape_json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}
