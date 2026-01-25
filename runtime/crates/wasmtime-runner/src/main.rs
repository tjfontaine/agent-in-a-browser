//! Wasmtime-based runner for the TUI component
//!
//! Provides native execution of the TUI WASM component with full MCP parity.
//!
//! ## Build Modes
//!
//! **Default (embed-wasm):** Bundles all WASM into a single binary.
//! Requires WASM to be built first:
//! ```bash
//! cargo component build --release -p web-agent-tui -p ts-runtime-mcp ...
//! cargo build --release -p wasmtime-runner
//! ```
//!
//! **Development (no-embed):** Load WASM from files at runtime:
//! ```bash
//! cargo build -p wasmtime-runner --no-default-features --features no-embed
//! ```

mod bindings;
mod host_traits;
mod http_router;
mod module_loader;

use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

use module_loader::ModuleLoader;

// Embedded WASM components (default)
#[cfg(feature = "embed-wasm")]
#[allow(dead_code)] // EDTUI/SQLITE/TSX will be used for lazy-loading
mod embedded {
    /// TUI WASM component
    pub static TUI_WASM: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../target/wasm32-wasip2/release/web_agent_tui.wasm"
    ));

    /// MCP server WASM component  
    pub static MCP_WASM: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../target/wasm32-wasip2/release/ts_runtime_mcp.wasm"
    ));

    /// edtui-module (vim) WASM
    pub static EDTUI_WASM: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../target/wasm32-wasip2/release/edtui_module.wasm"
    ));

    /// sqlite-module WASM
    pub static SQLITE_WASM: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../target/wasm32-wasip2/release/sqlite_module.wasm"
    ));

    /// tsx-engine WASM
    pub static TSX_WASM: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../target/wasm32-wasip2/release/tsx_engine.wasm"
    ));
}

/// Native wasmtime runner for the TUI WASM component
#[derive(Parser, Debug)]
#[command(name = "wasm-tui")]
#[command(about = "Run the TUI WASM component natively with full MCP parity")]
struct Args {
    /// Path to the TUI WASM component (only in no-embed mode)
    #[arg(value_name = "TUI_WASM")]
    #[cfg(feature = "no-embed")]
    tui_wasm: PathBuf,

    /// Path to the MCP server WASM component
    #[arg(long, default_value = "ts_runtime_mcp.wasm")]
    #[cfg(feature = "no-embed")]
    mcp_wasm: PathBuf,

    /// Directory containing lazy-loadable modules (edtui, sqlite, tsx)
    #[arg(long, default_value = ".")]
    #[cfg(feature = "no-embed")]
    modules_dir: PathBuf,
}

/// Host state for the WASM components
pub struct HostState {
    wasi: WasiCtx,
    http: WasiHttpCtx,
    table: ResourceTable,
    pub module_loader: ModuleLoader,
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for HostState {
    fn ctx(&mut self) -> &mut WasiHttpCtx {
        &mut self.http
    }
    fn table(&mut self) -> &mut ResourceTable {
        &mut self.table
    }
}

fn main() -> Result<()> {
    let args = Args::parse();

    // Run with tokio for async wasmtime support
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(args))
}

async fn run(_args: Args) -> Result<()> {
    // Configure wasmtime engine with component model
    let mut config = Config::new();
    config.async_support(true);
    config.wasm_component_model(true);

    let engine = Engine::new(&config)?;

    // Load WASM components
    #[cfg(feature = "embed-wasm")]
    let (tui_bytes, mcp_bytes) = {
        eprintln!("Using embedded WASM components");
        (embedded::TUI_WASM.to_vec(), embedded::MCP_WASM.to_vec())
    };

    #[cfg(feature = "no-embed")]
    let (tui_bytes, mcp_bytes) = {
        let tui = std::fs::read(&_args.tui_wasm)
            .with_context(|| format!("Failed to read TUI WASM: {:?}", _args.tui_wasm))?;
        let mcp = std::fs::read(&_args.mcp_wasm)
            .with_context(|| format!("Failed to read MCP WASM: {:?}", _args.mcp_wasm))?;
        (tui, mcp)
    };

    let tui_component = Component::new(&engine, &tui_bytes)?;
    let _mcp_component = Component::new(&engine, &mcp_bytes)?;

    // Create linker and add WASI bindings
    let mut linker: Linker<HostState> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi_http::add_only_http_to_linker_async(&mut linker)?;

    // Add custom host implementations (bindgen-generated for compile-time type safety)
    // Use HasSelf<_> wrapper which implements HasData for direct state access
    use wasmtime::component::HasSelf;
    bindings::add_terminal_size_to_linker::<_, HasSelf<_>>(&mut linker, |s| s)?;
    bindings::add_shell_command_to_linker::<_, HasSelf<_>>(&mut linker, |s| s)?;
    bindings::add_module_loader_to_linker::<_, HasSelf<_>>(&mut linker, |s| s)?;
    http_router::add_to_linker(&mut linker)?;

    // Build WASI context
    let wasi = WasiCtxBuilder::new().inherit_stdio().inherit_env().build();

    // Get modules directory
    #[cfg(feature = "embed-wasm")]
    let modules_dir = PathBuf::from(".");
    #[cfg(feature = "no-embed")]
    let modules_dir = _args.modules_dir;

    let state = HostState {
        wasi,
        http: WasiHttpCtx::new(),
        table: ResourceTable::new(),
        module_loader: ModuleLoader::new(modules_dir),
    };

    let mut store = Store::new(&engine, state);

    // Instantiate and run the TUI
    let instance = linker.instantiate_async(&mut store, &tui_component).await?;

    // Call the run() export
    let run_func = instance.get_typed_func::<(), (i32,)>(&mut store, "run")?;

    let (exit_code,) = run_func.call_async(&mut store, ()).await?;

    std::process::exit(exit_code);
}
