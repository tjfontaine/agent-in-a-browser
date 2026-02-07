//! Generated bindings from WIT files
//!
//! Uses wasmtime::component::bindgen! for compile-time type safety.
//! The generated Host traits provide compile-time verification of interface implementations.

#[allow(warnings)]
pub mod generated {
    // Generate bindings for the TUI guest component
    // Creates:
    // - Host traits for each imported interface (we implement these)
    // - Types for records/enums/resources
    wasmtime::component::bindgen!({
        path: "wit",
        world: "tui-guest",
        // Required because wasi:io types used with wasmtime_wasi_http require Send
        require_store_data_send: true,
        with: {
            // Remap wasi:io types to wasmtime_wasi implementations for type compatibility
            "wasi:io": wasmtime_wasi::p2::bindings::io,
        },
    });
}

// Re-export Host traits we need to implement
pub use generated::mcp::module_loader::loader::Host as ModuleLoaderHost;
pub use generated::mcp::module_loader::loader::HostLazyProcess;
pub use generated::shell::unix::command::Host as ShellCommandHost;
pub use generated::terminal::info::size::Host as TerminalSizeHost;

// Re-export generated types for our interfaces
pub use generated::mcp::module_loader::loader::{
    ExecEnv as LoaderExecEnv, LazyProcess, TerminalSize,
};
pub use generated::shell::unix::command::ExecEnv;
pub use generated::terminal::info::size::TerminalDimensions;

// Re-export the interface add_to_linker functions
pub use generated::mcp::module_loader::loader::add_to_linker as add_module_loader_to_linker;
pub use generated::shell::unix::command::add_to_linker as add_shell_command_to_linker;
pub use generated::terminal::info::size::add_to_linker as add_terminal_size_to_linker;
