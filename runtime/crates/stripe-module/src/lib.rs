//! stripe-module
//!
//! Provides the `stripe` command via the unix-command WIT interface.
//! This is a thin Rust shim that will be composed with the Go-compiled
//! Stripe CLI binary (adapted from wasip1 to wasip2 component model).
//!
//! The Go binary handles all actual Stripe CLI logic. This shim:
//! - Exports the shell:unix/command interface expected by the lazy module loader
//! - Forwards command invocations to the composed Go component
//! - Manages stream redirection between the WIT interface and Go component

#[allow(warnings)]
mod bindings;

use bindings::exports::shell::unix::command::{ExecEnv, Guest};
use bindings::wasi::io::streams::{InputStream, OutputStream};

struct StripeModule;

impl Guest for StripeModule {
    fn run(
        name: String,
        args: Vec<String>,
        env: ExecEnv,
        _stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) -> i32 {
        match name.as_str() {
            "stripe" => run_stripe(args, env, stdout, stderr),
            _ => {
                write_to_stream(&stderr, format!("Unknown command: {}\n", name).as_bytes());
                127
            }
        }
    }

    fn list_commands() -> Vec<String> {
        vec!["stripe".to_string()]
    }
}

/// Execute the stripe CLI command.
///
/// TODO: Once the Go binary is compiled and composed via wasm-tools compose,
/// this function will delegate to the Go component's main function.
/// For now, it serves as a placeholder that validates the module pipeline.
fn run_stripe(args: Vec<String>, _env: ExecEnv, stdout: OutputStream, stderr: OutputStream) -> i32 {
    // Placeholder: print usage info until Go binary is composed
    if args.is_empty() || args.first().map_or(false, |a| a == "--help" || a == "-h") {
        let help = concat!(
            "stripe - Stripe CLI (WASM)\n",
            "\n",
            "Usage: stripe <command> [flags]\n",
            "\n",
            "Available Commands:\n",
            "  login       Login to your Stripe account\n",
            "  listen      Listen for webhook events\n",
            "  trigger     Trigger test webhook events\n",
            "  logs        Interact with Stripe API request logs\n",
            "  resources   Interact with Stripe API resources\n",
            "  config      Manage CLI configuration\n",
            "  status      Check Stripe system status\n",
            "  version     Get the version of the Stripe CLI\n",
            "\n",
            "Note: This module is a WASM build of the Stripe CLI.\n",
            "HTTP calls are bridged through the browser's fetch() API.\n",
        );
        write_to_stream(&stdout, help.as_bytes());
        return 0;
    }

    write_to_stream(
        &stderr,
        b"stripe: Go component not yet composed. Run `make build-stripe` to compile the Go binary.\n",
    );
    1
}

/// Write data to an output stream
fn write_to_stream(stream: &OutputStream, data: &[u8]) {
    let mut offset = 0;
    while offset < data.len() {
        let chunk_size = stream.check_write().unwrap_or(0) as usize;
        if chunk_size == 0 {
            stream.blocking_flush().ok();
            continue;
        }
        let end = (offset + chunk_size).min(data.len());
        stream.write(&data[offset..end]).ok();
        offset = end;
    }
    stream.blocking_flush().ok();
}

bindings::export!(StripeModule with_types_in bindings);
