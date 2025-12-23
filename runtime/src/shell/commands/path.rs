//! Path manipulation commands: basename, dirname

use futures_lite::io::AsyncWriteExt;
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::parse_common;

/// Path manipulation commands.
pub struct PathCommands;

#[shell_commands]
impl PathCommands {
    /// basename - strip directory and suffix
    #[shell_command(
        name = "basename",
        usage = "basename PATH [SUFFIX]",
        description = "Strip directory and suffix from path"
    )]
    fn cmd_basename(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = PathCommands::show_help("basename") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                let _ = stderr.write_all(b"basename: missing operand\n").await;
                return 1;
            }
            
            let path = &remaining[0];
            let suffix = remaining.get(1).map(|s| s.as_str());
            
            let mut name = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
                
            if let Some(suf) = suffix {
                if name.ends_with(suf) {
                    name = name[..name.len() - suf.len()].to_string();
                }
            }
            
            let _ = stdout.write_all(name.as_bytes()).await;
            let _ = stdout.write_all(b"\n").await;
            0
        })
    }

    /// dirname - strip last component
    #[shell_command(
        name = "dirname",
        usage = "dirname PATH",
        description = "Strip last component from path"
    )]
    fn cmd_dirname(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = PathCommands::show_help("dirname") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                let _ = stderr.write_all(b"dirname: missing operand\n").await;
                return 1;
            }
            
            let path = &remaining[0];
            let parent = std::path::Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ".".to_string());
                
            let result = if parent.is_empty() { "." } else { &parent };
            
            let _ = stdout.write_all(result.as_bytes()).await;
            let _ = stdout.write_all(b"\n").await;
            0
        })
    }
}
