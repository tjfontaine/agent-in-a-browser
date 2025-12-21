//! Pipeline orchestrator - parses and executes shell pipelines.

use super::commands::ShellCommands;
use super::env::{ShellEnv, ShellResult};

/// Default pipe capacity in bytes.
const PIPE_CAPACITY: usize = 4096;

/// Run a shell pipeline.
/// 
/// Parses the command line, creates pipe chains, and executes all commands.
/// Returns the exit code of the last command in the pipeline.
pub async fn run_pipeline(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
    let cmd_line = cmd_line.trim();
    
    if cmd_line.is_empty() {
        return ShellResult::success("");
    }

    // Split by pipe
    let pipeline_parts: Vec<&str> = cmd_line.split('|').collect();
    let num_commands = pipeline_parts.len();

    if num_commands == 0 {
        return ShellResult::success("");
    }

    // Parse each command
    let mut commands: Vec<(String, Vec<String>)> = Vec::new();
    for part in &pipeline_parts {
        let part = part.trim();
        match shlex::split(part) {
            Some(tokens) if !tokens.is_empty() => {
                let cmd_name = tokens[0].clone();
                let args = tokens[1..].to_vec();
                commands.push((cmd_name, args));
            }
            _ => {
                return ShellResult::error(format!("Parse error: {}", part), 1);
            }
        }
    }

    // Verify all commands exist
    for (cmd_name, _) in &commands {
        if ShellCommands::get_command(cmd_name).is_none() {
            return ShellResult::error(format!("{}: command not found", cmd_name), 127);
        }
    }

    // Create stderr channel for all commands to share
    let (stderr_tx, _stderr_rx) = async_channel::bounded::<Vec<u8>>(16);

    // For a single command, we run it directly
    if num_commands == 1 {
        let (cmd_name, args) = commands.into_iter().next().unwrap();
        let cmd_fn = ShellCommands::get_command(&cmd_name).unwrap();

        // Create stdin (empty/closed)
        let (stdin_reader, stdin_writer) = piper::pipe(PIPE_CAPACITY);
        drop(stdin_writer);

        // Create stdout capture
        let (stdout_reader, stdout_writer) = piper::pipe(PIPE_CAPACITY);

        // Create stderr 
        let (stderr_reader, stderr_writer) = piper::pipe(PIPE_CAPACITY);

        // Run command
        let code = cmd_fn(args, env, stdin_reader, stdout_writer, stderr_writer).await;

        // Collect stdout
        let stdout = drain_reader(stdout_reader).await;
        let stderr = drain_reader(stderr_reader).await;

        drop(stderr_tx);

        return ShellResult {
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            code,
        };
    }

    // For pipelines, we need to coordinate stdin/stdout between commands
    // Create all the pipes upfront
    let mut all_pipes: Vec<(piper::Reader, piper::Writer)> = Vec::new();
    for _ in 0..=num_commands {
        all_pipes.push(piper::pipe(PIPE_CAPACITY));
    }

    // Close first stdin (no input)
    let (_first_stdin, _) = all_pipes.remove(0);
    let first_writer = {
        let (_, w) = piper::pipe(1);
        w
    };
    drop(first_writer); // Nothing to consume

    // We'll run each command, connecting them via intermediate buffers
    // Since we can't truly run in parallel in single-threaded WASM,
    // we buffer outputs and pass them along
    
    let mut current_input = Vec::<u8>::new();
    let mut final_code = 0i32;
    let mut all_stderr = Vec::<u8>::new();

    for (cmd_name, args) in commands.into_iter() {
        let cmd_fn = ShellCommands::get_command(&cmd_name).unwrap();

        // Create stdin from previous output
        let (stdin_reader, mut stdin_writer) = piper::pipe(PIPE_CAPACITY);
        
        // Write previous output to stdin (in a block to drop writer before reading)
        if !current_input.is_empty() {
            use futures_lite::io::AsyncWriteExt;
            let _ = stdin_writer.write_all(&current_input).await;
        }
        drop(stdin_writer); // Signal EOF

        // Create stdout capture
        let (stdout_reader, stdout_writer) = piper::pipe(PIPE_CAPACITY);

        // Create stderr capture
        let (stderr_reader, stderr_writer) = piper::pipe(PIPE_CAPACITY);

        // Run command
        let code = cmd_fn(args, env, stdin_reader, stdout_writer, stderr_writer).await;

        // Capture outputs
        current_input = drain_reader(stdout_reader).await;
        let cmd_stderr = drain_reader(stderr_reader).await;
        all_stderr.extend(cmd_stderr);

        // Track exit code (last command wins)
        final_code = code;
    }

    drop(stderr_tx);

    // Final output is in current_input
    ShellResult {
        stdout: String::from_utf8_lossy(&current_input).to_string(),
        stderr: String::from_utf8_lossy(&all_stderr).to_string(),
        code: final_code,
    }
}

/// Drain all data from a pipe reader into a Vec.
async fn drain_reader(mut reader: piper::Reader) -> Vec<u8> {
    let mut buf = [0u8; 4096];
    let mut result = Vec::new();
    loop {
        match futures_lite::io::AsyncReadExt::read(&mut reader, &mut buf).await {
            Ok(0) => break,
            Ok(n) => result.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    result
}

/// Run a simple single command (no pipes).
pub async fn run_simple(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
    run_pipeline(cmd_line, env).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_echo() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo hello world", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "hello world");
    }

    #[test]
    fn test_run_pwd() {
        let mut env = ShellEnv::new();
        env.cwd = std::path::PathBuf::from("/tmp");
        let result = futures_lite::future::block_on(run_pipeline("pwd", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "/tmp");
    }

    #[test]
    fn test_unknown_command() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("nonexistent", &mut env));
        assert_eq!(result.code, 127);
        assert!(result.stderr.contains("command not found"));
    }

    #[test]
    fn test_empty_command() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("", &mut env));
        assert_eq!(result.code, 0);
    }

    #[test]
    fn test_simple_pipeline() {
        let mut env = ShellEnv::new();
        // echo outputs "a\nb\nc\n", head -n 2 should output "a\nb\n"
        let result = futures_lite::future::block_on(run_pipeline("echo one | cat", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "one");
    }
}
