//! Git commands - placeholder for lazy-loaded gix-module
//!
//! Git functionality is provided by the gix-module WASM component.
//! The shell executor routes `git` commands to the lazy module loader.
//! This stub provides the command registration for help text display.

use futures_lite::io::AsyncWriteExt;
use runtime_macros::shell_commands;

use super::super::ShellEnv;

/// Git commands - routes to lazy-loaded gix-module
pub struct GitCommands;

#[shell_commands]
impl GitCommands {
    /// git - version control (provided by gix-module)
    #[shell_command(
        name = "git",
        usage = "git <command> [OPTIONS]",
        description = "Git version control (init, status, add, commit, log, diff, clone)"
    )]
    fn cmd_git(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            // Check for help flag
            let show_help = args.iter().any(|a| a == "-h" || a == "--help") || args.is_empty();

            if show_help {
                let help = "git - version control\n\n\
Usage: git <command> [OPTIONS]\n\n\
Commands:\n\
  init             Initialize a new repository\n\
  clone <url>      Clone a repository\n\
  status           Show working tree status\n\
  add <file>       Add file to staging\n\
  commit -m MSG    Create a new commit\n\
  log [-n N]       Show commit history\n\
  diff [file]      Show changes\n\n\
Note: Git is provided by gix-module (lazy-loaded).\n";
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            // This should not normally be reached - the shell executor should
            // dispatch to the lazy module via get_lazy_module("git") -> "gix-module"
            let msg =
                "git: gix-module not loaded. Git commands require the gix-module WASM component.\n";
            let _ = stderr.write_all(msg.as_bytes()).await;
            1
        })
    }
}
