//! Environment commands: env, printenv

use futures_lite::io::AsyncWriteExt;
use runtime_macros::{shell_command, shell_commands};

use super::super::ShellEnv;
use super::{parse_common, CommandFn};

/// Environment commands.
pub struct EnvCommands;

#[shell_commands]
impl EnvCommands {
    /// env - print environment
    #[shell_command(
        name = "env",
        usage = "env",
        description = "Print environment variables"
    )]
    fn cmd_env(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let env_vars = env.env_vars.clone();
        Box::pin(async move {
            let (opts, _) = parse_common(&args);
            if opts.help {
                if let Some(help) = EnvCommands::show_help("env") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            for (key, value) in &env_vars {
                let line = format!("{}={}\n", key, value);
                let _ = stdout.write_all(line.as_bytes()).await;
            }
            0
        })
    }

    /// printenv - print specific environment variable
    #[shell_command(
        name = "printenv",
        usage = "printenv [NAME]",
        description = "Print environment variable value"
    )]
    fn cmd_printenv(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let env_vars = env.env_vars.clone();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = EnvCommands::show_help("printenv") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                for (key, value) in &env_vars {
                    let line = format!("{}={}\n", key, value);
                    let _ = stdout.write_all(line.as_bytes()).await;
                }
            } else {
                for name in &remaining {
                    if let Some(value) = env_vars.get(name) {
                        let _ = stdout.write_all(value.as_bytes()).await;
                        let _ = stdout.write_all(b"\n").await;
                    } else {
                        return 1;
                    }
                }
            }
            0
        })
    }
}
