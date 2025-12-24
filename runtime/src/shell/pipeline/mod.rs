//! Pipeline orchestrator - parses and executes shell pipelines.
//!
//! Supports:
//! - Pipelines with | operator
//! - Logical chaining with &&, ||, ;
//! - I/O redirection: >, >>, <, 2>, 2>&1
//! - Variable expansion: $VAR, ${VAR}, ${VAR:-default}
//! - Command substitution: $(cmd), `cmd`
//! - Arithmetic expansion: $((expr))
//! - Brace expansion: {a,b,c}, {1..5}
//! - Control flow: if/then/else/fi, for/do/done, while/until, case/esac
//! - Glob expansion: *, ?

use super::env::{ShellEnv, ShellResult};

/// Maximum pipeline depth (for nested subshells/substitutions)
const MAX_SUBSHELL_DEPTH: usize = 16;

/// Maximum output size in bytes
#[allow(dead_code)] // reserved for future output size limiting
const MAX_OUTPUT_SIZE: usize = 10 * 1024 * 1024; // 10MB


/// Execute command substitution markers in a string
/// 
/// The expand module produces markers like `$__CMD_SUB__:cmd:__END__` which we 
/// need to execute and replace with their output.
pub async fn execute_command_substitutions(input: &str, env: &mut ShellEnv) -> String {
    let mut result = input.to_string();
    
    // Look for command substitution markers
    while let Some(start) = result.find("$__CMD_SUB__:") {
        let marker_start = start;
        let content_start = start + "$__CMD_SUB__:".len();
        
        if let Some(end_offset) = result[content_start..].find(":__END__") {
            let content_end = content_start + end_offset;
            let command = &result[content_start..content_end];
            
            // Execute the command in a subshell
            let mut sub_env = env.subshell();
            let cmd_result = Box::pin(run_pipeline(command, &mut sub_env)).await;
            
            // Replace the marker with the command output (trimmed of trailing newline)
            let output = cmd_result.stdout.trim_end_matches('\n');
            let marker_end = content_end + ":__END__".len();
            
            result = format!(
                "{}{}{}",
                &result[..marker_start],
                output,
                &result[marker_end..]
            );
        } else {
            // Malformed marker - skip it
            break;
        }
    }
    
    result
}

/// Resolve a path relative to cwd if not absolute
pub fn resolve_path(cwd: &str, path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else if cwd == "/" || cwd.is_empty() {
        format!("/{}", path)
    } else {
        format!("{}/{}", cwd, path)
    }
}

/// Normalize a path (resolve . and ..)
pub fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => { parts.pop(); }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

/// Run a shell pipeline with full shell semantics
/// 
/// Supports:
/// - Control flow: if/then/else/fi, for/do/done, while/until/do/done, case/esac
/// - Variable assignment: VAR=value, export VAR=value
/// - Variable expansion: $VAR, ${VAR}, ${VAR:-default}
/// - Command substitution: $(cmd), `cmd`
/// - Chaining operators: &&, ||, ;
/// - Pipelines: cmd1 | cmd2 | cmd3
pub async fn run_pipeline(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
    let cmd_line = cmd_line.trim();
    
    if cmd_line.is_empty() {
        return ShellResult::success("");
    }

    // Check subshell depth limit
    if env.subshell_depth > MAX_SUBSHELL_DEPTH {
        return ShellResult::error("maximum subshell depth exceeded", 1);
    }

    // Use the new executor which handles brush-parser exclusively
    // with proper stdin/stdout threading through pipelines
    super::new_executor::run_shell(cmd_line, env).await
}

#[cfg(test)]
mod tests;
