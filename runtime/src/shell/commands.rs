//! Shell command implementations.
//!
//! All commands write to async writers (not println!) and return exit codes.

use futures_lite::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use futures_lite::StreamExt;
use std::io;

use super::ShellEnv;

/// Command function type.
/// Takes arguments, environment, and stdin/stdout/stderr pipes.
/// Returns exit code.
pub type CommandFn = fn(
    args: Vec<String>,
    env: &ShellEnv,
    stdin: piper::Reader,
    stdout: piper::Writer,
    stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32>;

/// Dispatch a command by name.
pub fn get_command(name: &str) -> Option<CommandFn> {
    match name {
        "echo" => Some(cmd_echo),
        "pwd" => Some(cmd_pwd),
        "ls" => Some(cmd_ls),
        "cat" => Some(cmd_cat),
        "head" => Some(cmd_head),
        "yes" => Some(cmd_yes),
        "true" => Some(cmd_true),
        "false" => Some(cmd_false),
        _ => None,
    }
}

/// echo - output arguments
fn cmd_echo(
    args: Vec<String>,
    _env: &ShellEnv,
    _stdin: piper::Reader,
    mut stdout: piper::Writer,
    _stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32> {
    Box::pin(async move {
        let output = args.join(" ");
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
fn cmd_pwd(
    _args: Vec<String>,
    env: &ShellEnv,
    _stdin: piper::Reader,
    mut stdout: piper::Writer,
    _stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32> {
    let cwd = env.cwd.to_string_lossy().to_string();
    Box::pin(async move {
        if stdout.write_all(cwd.as_bytes()).await.is_err() {
            return 1;
        }
        if stdout.write_all(b"\n").await.is_err() {
            return 1;
        }
        0
    })
}

/// ls - list directory
fn cmd_ls(
    args: Vec<String>,
    env: &ShellEnv,
    _stdin: piper::Reader,
    mut stdout: piper::Writer,
    mut stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32> {
    // Use "/" for root like the working list MCP tool
    let cwd_str = env.cwd.to_string_lossy();
    let path = if args.is_empty() {
        // If cwd is "." or empty, use "/" like the working list tool
        if cwd_str == "." || cwd_str.is_empty() {
            "/".to_string()
        } else {
            cwd_str.to_string()
        }
    } else if args[0].starts_with('/') {
        args[0].clone()
    } else if cwd_str == "." || cwd_str.is_empty() {
        // Relative path from root
        format!("/{}", args[0])
    } else {
        format!("{}/{}", cwd_str, args[0])
    };

    Box::pin(async move {
        match std::fs::read_dir(&path) {
            Ok(entries) => {
                let mut names: Vec<String> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            format!("{}/", name)
                        } else {
                            name
                        }
                    })
                    .collect();
                names.sort();
                
                for name in names {
                    if stdout.write_all(name.as_bytes()).await.is_err() {
                        return 1;
                    }
                    if stdout.write_all(b"\n").await.is_err() {
                        return 1;
                    }
                }
                0
            }
            Err(e) => {
                let msg = format!("ls: {}: {}\n", path, e);
                let _ = stderr.write_all(msg.as_bytes()).await;
                1
            }
        }
    })
}

/// cat - copy stdin to stdout
fn cmd_cat(
    args: Vec<String>,
    env: &ShellEnv,
    stdin: piper::Reader,
    mut stdout: piper::Writer,
    mut stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32> {
    // Clone cwd as string upfront to avoid lifetime issues
    let cwd = env.cwd.to_string_lossy().to_string();
    
    // If args provided, read from files; otherwise read stdin
    Box::pin(async move {
        if args.is_empty() {
            // Read from stdin
            let mut buf = [0u8; 4096];
            let mut reader = stdin;
            loop {
                match futures_lite::io::AsyncReadExt::read(&mut reader, &mut buf).await {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        if stdout.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        } else {
            // Read from files using string paths
            for arg in &args {
                let path = if arg.starts_with('/') {
                    arg.clone()
                } else {
                    format!("{}/{}", cwd, arg)
                };
                
                match std::fs::read_to_string(&path) {
                    Ok(content) => {
                        if stdout.write_all(content.as_bytes()).await.is_err() {
                            return 1;
                        }
                    }
                    Err(e) => {
                        let msg = format!("cat: {}: {}\n", path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                }
            }
        }
        0
    })
}

/// head - output first N lines (default 10)
fn cmd_head(
    args: Vec<String>,
    _env: &ShellEnv,
    stdin: piper::Reader,
    mut stdout: piper::Writer,
    _stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32> {
    // Parse -n <count> argument
    let mut count = 10usize;
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        if arg == "-n" {
            if let Some(n_str) = iter.next() {
                if let Ok(n) = n_str.parse::<usize>() {
                    count = n;
                }
            }
        }
    }

    Box::pin(async move {
        let reader = BufReader::new(stdin);
        let mut lines = reader.lines();
        let mut written = 0;

        while written < count {
            match lines.next().await {
                Some(Ok(line)) => {
                    if stdout.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    if stdout.write_all(b"\n").await.is_err() {
                        break;
                    }
                    written += 1;
                }
                Some(Err(_)) => break,
                None => break, // EOF
            }
        }
        0
    })
}

/// yes - output "y" repeatedly (handles BrokenPipe gracefully)
fn cmd_yes(
    args: Vec<String>,
    _env: &ShellEnv,
    _stdin: piper::Reader,
    mut stdout: piper::Writer,
    _stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32> {
    let output = if args.is_empty() {
        "y".to_string()
    } else {
        args.join(" ")
    };

    Box::pin(async move {
        let line = format!("{}\n", output);
        loop {
            match stdout.write_all(line.as_bytes()).await {
                Ok(_) => continue,
                Err(e) if e.kind() == io::ErrorKind::BrokenPipe => {
                    // Reader dropped - exit gracefully
                    return 0;
                }
                Err(_) => return 1,
            }
        }
    })
}

/// true - exit with 0
fn cmd_true(
    _args: Vec<String>,
    _env: &ShellEnv,
    _stdin: piper::Reader,
    _stdout: piper::Writer,
    _stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32> {
    Box::pin(async { 0 })
}

/// false - exit with 1
fn cmd_false(
    _args: Vec<String>,
    _env: &ShellEnv,
    _stdin: piper::Reader,
    _stdout: piper::Writer,
    _stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32> {
    Box::pin(async { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_command() {
        assert!(get_command("echo").is_some());
        assert!(get_command("ls").is_some());
        assert!(get_command("nonexistent").is_none());
    }
}
