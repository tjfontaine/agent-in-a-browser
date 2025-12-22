//! Pipeline orchestrator - parses and executes shell pipelines.

use super::commands::ShellCommands;
use super::env::{ShellEnv, ShellResult};

/// Default pipe capacity in bytes.
const PIPE_CAPACITY: usize = 4096;

/// Expand glob patterns in arguments.
/// 
/// If an argument contains `*` or `?`, it's expanded to matching files
/// in the given directory. If no matches are found, the pattern is returned as-is.
fn expand_globs(args: &[String], cwd: &str) -> Vec<String> {
    let mut result = Vec::new();
    
    for arg in args {
        if arg.contains('*') || arg.contains('?') {
            // This is a glob pattern - expand it
            let matches = expand_single_glob(arg, cwd);
            if matches.is_empty() {
                // No matches - pass pattern as-is (bash behavior varies, we keep it)
                result.push(arg.clone());
            } else {
                result.extend(matches);
            }
        } else {
            // Not a glob - pass through
            result.push(arg.clone());
        }
    }
    
    result
}

/// Expand a single glob pattern against the filesystem.
fn expand_single_glob(pattern: &str, cwd: &str) -> Vec<String> {
    let mut matches = Vec::new();
    
    // Handle pattern with directory component
    let (dir, file_pattern) = if pattern.contains('/') {
        // Has directory component - split it
        let last_slash = pattern.rfind('/').unwrap();
        let dir = &pattern[..last_slash];
        let file_pat = &pattern[last_slash + 1..];
        
        // Resolve directory relative to cwd
        let full_dir = if dir.starts_with('/') {
            dir.to_string()
        } else if cwd == "/" || cwd.is_empty() {
            format!("/{}", dir)
        } else {
            format!("{}/{}", cwd, dir)
        };
        (full_dir, file_pat.to_string())
    } else {
        // Just a filename pattern - search in cwd
        let dir = if cwd.is_empty() || cwd == "." {
            "/".to_string()
        } else {
            cwd.to_string()
        };
        (dir, pattern.to_string())
    };
    
    // Read directory and match files
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            
            // Skip hidden files unless pattern starts with .
            if name.starts_with('.') && !file_pattern.starts_with('.') {
                continue;
            }
            
            if glob_match(&file_pattern, &name) {
                // Return path relative to original pattern style
                if pattern.contains('/') {
                    // Preserve the directory prefix from the pattern
                    let prefix = &pattern[..pattern.rfind('/').unwrap() + 1];
                    matches.push(format!("{}{}", prefix, name));
                } else {
                    matches.push(name);
                }
            }
        }
    }
    
    matches.sort();
    matches
}

/// Simple glob pattern matching (supports * and ?)
fn glob_match(pattern: &str, text: &str) -> bool {
    let mut p_chars = pattern.chars().peekable();
    let mut t_chars = text.chars().peekable();
    
    while let Some(pc) = p_chars.next() {
        match pc {
            '*' => {
                // Match zero or more characters
                if p_chars.peek().is_none() {
                    return true; // * at end matches everything
                }
                // Try matching rest of pattern at every position
                let rest_pattern: String = p_chars.collect();
                let mut remaining: String = t_chars.collect();
                while !remaining.is_empty() {
                    if glob_match(&rest_pattern, &remaining) {
                        return true;
                    }
                    remaining = remaining.chars().skip(1).collect();
                }
                return glob_match(&rest_pattern, "");
            }
            '?' => {
                // Match exactly one character
                if t_chars.next().is_none() {
                    return false;
                }
            }
            c => {
                if t_chars.next() != Some(c) {
                    return false;
                }
            }
        }
    }
    
    t_chars.peek().is_none()
}

/// Operator for chaining commands
#[derive(Debug, Clone, Copy, PartialEq)]
enum ChainOp {
    /// && - run next only if previous succeeded
    And,
    /// || - run next only if previous failed
    Or,
    /// ; - always run next
    Seq,
}

/// Resolve a path relative to cwd if not absolute
fn resolve_path(cwd: &str, path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else if cwd == "/" || cwd.is_empty() {
        format!("/{}", path)
    } else {
        format!("{}/{}", cwd, path)
    }
}

/// I/O redirections for a command
#[derive(Debug, Clone, Default)]
struct Redirects {
    /// stdout redirect: (path, append?)
    stdout: Option<(String, bool)>,
    /// stderr redirect: path or special ">&1" for merge
    stderr: Option<String>,
    /// stdin redirect: path
    stdin: Option<String>,
}

/// Parse redirections from tokens, returning (cmd_args, redirects)
fn parse_redirects(tokens: Vec<String>) -> (Vec<String>, Redirects) {
    let mut args = Vec::new();
    let mut redirects = Redirects::default();
    
    let mut iter = tokens.into_iter().peekable();
    while let Some(tok) = iter.next() {
        if tok == ">" {
            // stdout overwrite
            if let Some(path) = iter.next() {
                redirects.stdout = Some((path, false));
            }
        } else if tok == ">>" {
            // stdout append
            if let Some(path) = iter.next() {
                redirects.stdout = Some((path, true));
            }
        } else if tok == "<" {
            // stdin
            if let Some(path) = iter.next() {
                redirects.stdin = Some(path);
            }
        } else if tok == "2>&1" {
            // merge stderr to stdout
            redirects.stderr = Some(">&1".to_string());
        } else if tok == "2>" {
            // stderr to file
            if let Some(path) = iter.next() {
                redirects.stderr = Some(path);
            }
        } else if tok.starts_with(">") && tok.len() > 1 {
            // >file (no space)
            redirects.stdout = Some((tok[1..].to_string(), false));
        } else if tok.starts_with(">>") && tok.len() > 2 {
            // >>file (no space)
            redirects.stdout = Some((tok[2..].to_string(), true));
        } else if tok.starts_with("<") && tok.len() > 1 {
            // <file (no space)
            redirects.stdin = Some(tok[1..].to_string());
        } else {
            args.push(tok);
        }
    }
    
    (args, redirects)
}


/// Run a shell pipeline with support for &&, ||, and ; operators.
/// 
/// Parses the command line, handles chaining operators, creates pipe chains, 
/// and executes all commands. Returns the exit code of the last command.
pub async fn run_pipeline(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
    let cmd_line = cmd_line.trim();
    
    if cmd_line.is_empty() {
        return ShellResult::success("");
    }

    // First, split by chain operators (&&, ||, ;) while preserving the operator
    let chain_segments = split_by_chain_ops(cmd_line);
    
    let mut combined_stdout = String::new();
    let mut combined_stderr = String::new();
    let mut last_code = 0i32;
    
    for (segment, op) in chain_segments {
        // Check if we should run this segment based on previous result
        let should_run = match op {
            None => true, // First segment always runs
            Some(ChainOp::And) => last_code == 0,
            Some(ChainOp::Or) => last_code != 0,
            Some(ChainOp::Seq) => true,
        };
        
        if should_run {
            let result = run_single_pipeline(segment.trim(), env).await;
            combined_stdout.push_str(&result.stdout);
            combined_stderr.push_str(&result.stderr);
            last_code = result.code;
        }
    }
    
    ShellResult {
        stdout: combined_stdout,
        stderr: combined_stderr,
        code: last_code,
    }
}

/// Split command line by chain operators (&&, ||, ;)
/// Returns Vec of (segment, preceding_operator)
fn split_by_chain_ops(cmd_line: &str) -> Vec<(&str, Option<ChainOp>)> {
    let mut result = Vec::new();
    let mut remaining = cmd_line;
    let mut prev_op: Option<ChainOp> = None;
    
    loop {
        // Find the next chain operator
        let and_pos = remaining.find("&&");
        let or_pos = remaining.find("||");
        let seq_pos = remaining.find(';');
        
        // Find the earliest operator
        let next_split = [
            and_pos.map(|p| (p, 2, ChainOp::And)),
            or_pos.map(|p| (p, 2, ChainOp::Or)),
            seq_pos.map(|p| (p, 1, ChainOp::Seq)),
        ]
        .into_iter()
        .flatten()
        .min_by_key(|(pos, _, _)| *pos);
        
        match next_split {
            Some((pos, len, op)) => {
                let segment = &remaining[..pos];
                if !segment.trim().is_empty() {
                    result.push((segment, prev_op));
                }
                prev_op = Some(op);
                remaining = &remaining[pos + len..];
            }
            None => {
                // No more operators, push remaining if non-empty
                if !remaining.trim().is_empty() {
                    result.push((remaining, prev_op));
                }
                break;
            }
        }
    }
    
    result
}

/// Run a single pipeline (handles | only, no &&/||/;)
async fn run_single_pipeline(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
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

    // Parse each command with redirections
    let mut commands: Vec<(String, Vec<String>, Redirects)> = Vec::new();
    for part in &pipeline_parts {
        let part = part.trim();
        match shlex::split(part) {
            Some(tokens) if !tokens.is_empty() => {
                let cmd_name = tokens[0].clone();
                // Parse redirections first, then expand globs on remaining args
                let (remaining_tokens, redirects) = parse_redirects(tokens[1..].to_vec());
                let args = expand_globs(&remaining_tokens, &env.cwd.to_string_lossy());
                commands.push((cmd_name, args, redirects));
            }
            _ => {
                return ShellResult::error(format!("Parse error: {}", part), 1);
            }
        }
    }

    // Verify all commands exist
    for (cmd_name, _, _) in &commands {
        if ShellCommands::get_command(cmd_name).is_none() {
            return ShellResult::error(format!("{}: command not found", cmd_name), 127);
        }
    }

    // Create stderr channel for all commands to share
    let (stderr_tx, _stderr_rx) = async_channel::bounded::<Vec<u8>>(16);

    // For a single command, we run it directly
    if num_commands == 1 {
        let (cmd_name, args, redirects) = commands.into_iter().next().unwrap();
        let cmd_fn = ShellCommands::get_command(&cmd_name).unwrap();
        let cwd = env.cwd.to_string_lossy().to_string();

        // Handle stdin redirect
        let (stdin_reader, mut stdin_writer) = piper::pipe(PIPE_CAPACITY);
        if let Some(ref path) = redirects.stdin {
            let full_path = resolve_path(&cwd, path);
            match std::fs::read(&full_path) {
                Ok(content) => {
                    use futures_lite::io::AsyncWriteExt;
                    let _ = stdin_writer.write_all(&content).await;
                }
                Err(e) => {
                    return ShellResult::error(format!("{}: {}", path, e), 1);
                }
            }
        }
        drop(stdin_writer);

        // Create stdout capture
        let (stdout_reader, stdout_writer) = piper::pipe(PIPE_CAPACITY);

        // Create stderr 
        let (stderr_reader, stderr_writer) = piper::pipe(PIPE_CAPACITY);

        // Run command
        let code = cmd_fn(args, env, stdin_reader, stdout_writer, stderr_writer).await;

        // Collect stdout and stderr
        let stdout_bytes = drain_reader(stdout_reader).await;
        let stderr_bytes = drain_reader(stderr_reader).await;

        drop(stderr_tx);

        // Apply stdout redirect
        let stdout = if let Some((ref path, append)) = redirects.stdout {
            let full_path = resolve_path(&cwd, path);
            let result = if append {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&full_path)
                    .and_then(|mut f| std::io::Write::write_all(&mut f, &stdout_bytes))
            } else {
                std::fs::write(&full_path, &stdout_bytes)
            };
            if let Err(e) = result {
                return ShellResult::error(format!("{}: {}", path, e), 1);
            }
            String::new() // Output was redirected, don't show
        } else {
            String::from_utf8_lossy(&stdout_bytes).to_string()
        };

        // Apply stderr redirect
        let stderr = match &redirects.stderr {
            Some(s) if s == ">&1" => {
                // Merge stderr to stdout (for redirects, append to file; otherwise return combined)
                if redirects.stdout.is_some() {
                    let (ref path, _) = redirects.stdout.as_ref().unwrap();
                    let full_path = resolve_path(&cwd, path);
                    let _ = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&full_path)
                        .and_then(|mut f| std::io::Write::write_all(&mut f, &stderr_bytes));
                    String::new()
                } else {
                    // Just combine with stdout in output
                    String::from_utf8_lossy(&stderr_bytes).to_string()
                }
            }
            Some(path) => {
                let full_path = resolve_path(&cwd, path);
                let _ = std::fs::write(&full_path, &stderr_bytes);
                String::new()
            }
            None => String::from_utf8_lossy(&stderr_bytes).to_string(),
        };

        return ShellResult {
            stdout,
            stderr,
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

    for (cmd_name, args, _redirects) in commands.into_iter() {
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
