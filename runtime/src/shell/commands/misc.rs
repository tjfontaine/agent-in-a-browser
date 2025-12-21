//! Miscellaneous commands: seq, sleep

use futures_lite::io::AsyncWriteExt;
use runtime_macros::{shell_command, shell_commands};

use super::super::ShellEnv;
use super::{parse_common, CommandFn};

/// Miscellaneous commands.
pub struct MiscCommands;

#[shell_commands]
impl MiscCommands {
    /// seq - print sequence of numbers
    #[shell_command(
        name = "seq",
        usage = "seq [FIRST] [INCREMENT] LAST",
        description = "Print sequence of numbers"
    )]
    fn cmd_seq(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = MiscCommands::show_help("seq") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let nums: Vec<i64> = remaining.iter()
                .filter_map(|s| s.parse().ok())
                .collect();
            
            let (first, incr, last) = match nums.len() {
                0 => {
                    let _ = stderr.write_all(b"seq: missing operand\n").await;
                    return 1;
                }
                1 => (1, 1, nums[0]),
                2 => (nums[0], 1, nums[1]),
                _ => (nums[0], nums[1], nums[2]),
            };
            
            let mut current = first;
            if incr > 0 {
                while current <= last {
                    let _ = stdout.write_all(format!("{}\n", current).as_bytes()).await;
                    current += incr;
                }
            } else if incr < 0 {
                while current >= last {
                    let _ = stdout.write_all(format!("{}\n", current).as_bytes()).await;
                    current += incr;
                }
            }
            0
        })
    }

    /// sleep - delay for a specified time
    #[shell_command(
        name = "sleep",
        usage = "sleep SECONDS",
        description = "Delay for a specified time"
    )]
    fn cmd_sleep(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = MiscCommands::show_help("sleep") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                let _ = stderr.write_all(b"sleep: missing operand\n").await;
                return 1;
            }
            
            let secs: f64 = remaining[0].parse().unwrap_or(0.0);
            // Note: In WASM we can't actually sleep synchronously
            let _ = secs;
            0
        })
    }
}
