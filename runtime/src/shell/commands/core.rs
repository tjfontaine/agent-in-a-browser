//! Core shell commands: echo, pwd, true, false, yes, help

use futures_lite::io::AsyncWriteExt;
use runtime_macros::{shell_command, shell_commands};
use std::io;

use super::super::ShellEnv;
use super::{parse_common, CommandFn, ShellCommands};

/// Core commands - basic shell utilities.
pub struct CoreCommands;

#[shell_commands]
impl CoreCommands {
    /// echo - output arguments
    #[shell_command(
        name = "echo", 
        usage = "echo [STRING]...", 
        description = "Display line of text"
    )]
    fn cmd_echo(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = CoreCommands::show_help("echo") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            let output = remaining.join(" ");
            if stdout.write_all(output.as_bytes()).await.is_err() {
                return 1;
            }
            if stdout.write_all(b"\n").await.is_err() {
                return 1;
            }
            0
        })
    }

    /// pwd - print working directory
    #[shell_command(
        name = "pwd",
        usage = "pwd",
        description = "Print current working directory"
    )]
    fn cmd_pwd(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, _) = parse_common(&args);
            if opts.help {
                if let Some(help) = CoreCommands::show_help("pwd") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            if stdout.write_all(cwd.as_bytes()).await.is_err() {
                return 1;
            }
            if stdout.write_all(b"\n").await.is_err() {
                return 1;
            }
            0
        })
    }

    /// yes - output "y" repeatedly (handles BrokenPipe gracefully)
    #[shell_command(
        name = "yes",
        usage = "yes [STRING]",
        description = "Output a string repeatedly until killed"
    )]
    fn cmd_yes(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let (opts, remaining) = parse_common(&args);
        let output = if remaining.is_empty() {
            "y".to_string()
        } else {
            remaining.join(" ")
        };

        Box::pin(async move {
            if opts.help {
                if let Some(help) = CoreCommands::show_help("yes") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            let line = format!("{}\n", output);
            loop {
                match stdout.write_all(line.as_bytes()).await {
                    Ok(_) => continue,
                    Err(e) if e.kind() == io::ErrorKind::BrokenPipe => return 0,
                    Err(_) => return 1,
                }
            }
        })
    }

    /// true - exit with 0
    #[shell_command(
        name = "true",
        usage = "true",
        description = "Do nothing, successfully"
    )]
    fn cmd_true(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, _) = parse_common(&args);
            if opts.help {
                if let Some(help) = CoreCommands::show_help("true") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            0
        })
    }

    /// false - exit with 1
    #[shell_command(
        name = "false",
        usage = "false",
        description = "Do nothing, unsuccessfully"
    )]
    fn cmd_false(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, _) = parse_common(&args);
            if opts.help {
                if let Some(help) = CoreCommands::show_help("false") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            1
        })
    }

    /// help - display available commands or help for a specific command
    #[shell_command(
        name = "help",
        usage = "help [COMMAND]",
        description = "Display available commands or help for a specific command"
    )]
    fn cmd_help(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = CoreCommands::show_help("help") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                // List all commands
                let commands = ShellCommands::list_commands();
                let _ = stdout.write_all(b"Available commands:\n").await;
                
                // Display in columns
                for chunk in commands.chunks(5) {
                    let line = chunk.iter()
                        .map(|c| format!("{:<12}", c))
                        .collect::<Vec<_>>()
                        .join("");
                    let _ = stdout.write_all(format!("  {}\n", line.trim_end()).as_bytes()).await;
                }
                let _ = stdout.write_all(b"\nUse 'help COMMAND' for more information on a specific command.\n").await;
                0
            } else {
                // Show help for specific command
                let cmd_name = &remaining[0];
                if let Some(help) = ShellCommands::show_help(cmd_name) {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    0
                } else {
                    let _ = stderr.write_all(format!("help: no help for '{}'\n", cmd_name).as_bytes()).await;
                    1
                }
            }
        })
    }
}
