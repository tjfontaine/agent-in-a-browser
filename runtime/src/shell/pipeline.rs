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

use super::commands::ShellCommands;
use super::env::{ShellEnv, ShellResult};
use super::expand::{expand_braces, expand_string};

/// Default pipe capacity in bytes.
const PIPE_CAPACITY: usize = 4096;

/// Maximum pipeline depth (for nested subshells/substitutions)
const MAX_SUBSHELL_DEPTH: usize = 16;

/// Maximum loop iterations (safety limit)
const MAX_LOOP_ITERATIONS: usize = 10000;

/// Maximum output size in bytes
#[allow(dead_code)] // reserved for future output size limiting
const MAX_OUTPUT_SIZE: usize = 10 * 1024 * 1024; // 10MB

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
fn resolve_path(cwd: &str, path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else if cwd == "/" || cwd.is_empty() {
        format!("/{}", path)
    } else {
        format!("{}/{}", cwd, path)
    }
}

/// Check if a command is a special built-in that modifies environment
fn is_builtin(name: &str) -> bool {
    matches!(name, "cd" | "pushd" | "popd" | "dirs")
}

/// Normalize a path (resolve . and ..)
fn normalize_path(path: &str) -> String {
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

/// Handle cd built-in command
fn handle_cd(args: &[String], env: &mut ShellEnv) -> ShellResult {
    use std::path::PathBuf;
    
    let target = if args.is_empty() || args[0] == "~" {
        // cd with no args or ~ goes to home (in our case, /)
        "/".to_string()
    } else if args[0] == "-" {
        // cd - goes to previous directory
        let prev = env.prev_cwd.to_string_lossy().to_string();
        // Print the directory we're switching to
        println!("{}", prev);
        prev
    } else {
        // Resolve path relative to cwd
        resolve_path(&env.cwd.to_string_lossy(), &args[0])
    };
    
    let normalized = normalize_path(&target);
    
    // Verify directory exists
    if let Ok(metadata) = std::fs::metadata(&normalized) {
        if !metadata.is_dir() {
            return ShellResult::error(format!("cd: {}: Not a directory", args.get(0).unwrap_or(&"~".to_string())), 1);
        }
    } else {
        return ShellResult::error(format!("cd: {}: No such file or directory", args.get(0).unwrap_or(&"~".to_string())), 1);
    }
    
    // Save current as previous, then update cwd
    env.prev_cwd = env.cwd.clone();
    env.cwd = PathBuf::from(normalized);
    
    ShellResult::success("")
}

/// Handle pushd built-in command
fn handle_pushd(args: &[String], env: &mut ShellEnv) -> ShellResult {
    use std::path::PathBuf;
    
    if args.is_empty() {
        // pushd with no args swaps top of stack with cwd
        if let Some(top) = env.dir_stack.pop() {
            let old_cwd = env.cwd.clone();
            env.prev_cwd = env.cwd.clone();
            env.cwd = top;
            env.dir_stack.push(old_cwd);
        } else {
            return ShellResult::error("pushd: no other directory", 1);
        }
    } else {
        // pushd <dir> pushes cwd to stack and changes to <dir>
        let target = resolve_path(&env.cwd.to_string_lossy(), &args[0]);
        let normalized = normalize_path(&target);
        
        // Verify directory exists
        if let Ok(metadata) = std::fs::metadata(&normalized) {
            if !metadata.is_dir() {
                return ShellResult::error(format!("pushd: {}: Not a directory", args[0]), 1);
            }
        } else {
            return ShellResult::error(format!("pushd: {}: No such file or directory", args[0]), 1);
        }
        
        env.dir_stack.push(env.cwd.clone());
        env.prev_cwd = env.cwd.clone();
        env.cwd = PathBuf::from(normalized);
    }
    
    // Print directory stack
    let dirs = format_dir_stack(env);
    ShellResult::success(dirs)
}

/// Handle popd built-in command
fn handle_popd(_args: &[String], env: &mut ShellEnv) -> ShellResult {
    if let Some(dir) = env.dir_stack.pop() {
        env.prev_cwd = env.cwd.clone();
        env.cwd = dir;
        let dirs = format_dir_stack(env);
        ShellResult::success(dirs)
    } else {
        ShellResult::error("popd: directory stack empty", 1)
    }
}

/// Handle dirs built-in command
fn handle_dirs(_args: &[String], env: &mut ShellEnv) -> ShellResult {
    let dirs = format_dir_stack(env);
    ShellResult::success(dirs)
}

/// Format directory stack for display
fn format_dir_stack(env: &ShellEnv) -> String {
    let mut result = env.cwd.to_string_lossy().to_string();
    for dir in env.dir_stack.iter().rev() {
        result.push(' ');
        result.push_str(&dir.to_string_lossy());
    }
    result.push('\n');
    result
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
    /// Here-document content (<<EOF)
    heredoc: Option<String>,
    /// Here-string content (<<<)
    herestring: Option<String>,
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
        } else if tok == "<<<" {
            // here-string
            if let Some(content) = iter.next() {
                // Remove quotes if present
                let content = content.trim_matches(|c| c == '"' || c == '\'');
                redirects.herestring = Some(content.to_string());
            }
        } else if tok.starts_with("<<<") {
            // here-string (no space)
            let content = tok[3..].trim_matches(|c| c == '"' || c == '\'');
            redirects.herestring = Some(content.to_string());
        } else if tok == "<<" || tok == "<<-" {
            // here-document
            let strip_tabs = tok == "<<-";
            if let Some(delimiter) = iter.next() {
                // Collect until we find the delimiter on its own line
                let heredoc_content = parse_heredoc_content(&mut iter, &delimiter, strip_tabs);
                redirects.heredoc = Some(heredoc_content);
            }
        } else if tok.starts_with("<<-") {
            // here-document with tab stripping (no space)
            let delimiter = &tok[3..];
            let heredoc_content = parse_heredoc_content(&mut iter, delimiter, true);
            redirects.heredoc = Some(heredoc_content);
        } else if tok.starts_with("<<") && !tok.starts_with("<<<") {
            // here-document (no space)
            let delimiter = &tok[2..];
            let heredoc_content = parse_heredoc_content(&mut iter, delimiter, false);
            redirects.heredoc = Some(heredoc_content);
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

/// Parse here-document content from remaining tokens
fn parse_heredoc_content<I: Iterator<Item = String>>(
    iter: &mut std::iter::Peekable<I>,
    delimiter: &str,
    strip_tabs: bool,
) -> String {
    let mut content = String::new();
    
    // In shell, here-doc content comes from the following lines
    // Since we're parsing a single command line, we'll look for the delimiter
    // pattern in the remaining tokens, separated by line breaks
    for tok in iter.by_ref() {
        if tok.trim() == delimiter {
            break;
        }
        let line = if strip_tabs {
            tok.trim_start_matches('\t')
        } else {
            &tok
        };
        if !content.is_empty() {
            content.push('\n');
        }
        content.push_str(line);
    }
    
    content
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

    // Try parsing with brush-parser first for ALL commands
    // This provides proper tokenization and handles complex compositions correctly
    match super::parser::parse_command(cmd_line) {
        Ok(parsed_cmds) if !parsed_cmds.is_empty() => {
            return super::executor::execute_sequence(&parsed_cmds, env).await;
        }
        Ok(_) => {
            // Empty parse result - fall through to old parser
        }
        Err(_e) => {
            // Parse error - fall through to old parser
            // This handles edge cases brush-parser doesn't support yet
        }
    }

    // Fallback: Check for control flow constructs with old parser
    if let Some(result) = try_parse_control_flow(cmd_line, env).await {
        return result;
    }

    // Check for variable assignment (VAR=value or export VAR=value)
    if let Some(result) = try_parse_assignment(cmd_line, env).await {
        return result;
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
            let segment = segment.trim();
            
            // Check for subshell (...)
            if segment.starts_with('(') && segment.ends_with(')') {
                let inner = &segment[1..segment.len()-1];
                let mut sub_env = env.subshell();
                let result = Box::pin(run_pipeline(inner, &mut sub_env)).await;
                combined_stdout.push_str(&result.stdout);
                combined_stderr.push_str(&result.stderr);
                last_code = result.code;
                continue;
            }
            
            // Check for control flow constructs in this segment
            if let Some(result) = try_parse_control_flow(segment, env).await {
                combined_stdout.push_str(&result.stdout);
                combined_stderr.push_str(&result.stderr);
                last_code = result.code;
                continue;
            }
            
            let result = run_single_pipeline(segment, env).await;
            combined_stdout.push_str(&result.stdout);
            combined_stderr.push_str(&result.stderr);
            last_code = result.code;
            
            // Update $? for next command
            env.last_exit_code = last_code;
            
            // Handle errexit option
            if env.options.errexit && last_code != 0 {
                break;
            }
        }
    }
    
    env.last_exit_code = last_code;
    
    ShellResult {
        stdout: combined_stdout,
        stderr: combined_stderr,
        code: last_code,
    }
}

/// Split a control flow construct from any trailing pipe commands
/// For example: "for x in a b c; do echo $x; done | wc -l" 
/// Returns: ("for x in a b c; do echo $x; done", Some("wc -l"))
fn split_control_flow_and_pipe(cmd_line: &str, terminator: &str) -> (String, Option<String>) {
    // Find the last occurrence of the terminator (done, fi, esac)
    // that's followed by whitespace and a pipe
    if let Some(term_pos) = cmd_line.rfind(terminator) {
        let after_term = &cmd_line[term_pos + terminator.len()..];
        let after_trimmed = after_term.trim_start();
        
        if after_trimmed.starts_with('|') {
            // There's a pipe after the terminator
            let control_part = &cmd_line[..term_pos + terminator.len()];
            let pipe_rest = after_trimmed[1..].trim(); // Skip the '|' and trim
            return (control_part.to_string(), Some(pipe_rest.to_string()));
        }
    }
    
    // No trailing pipe found
    (cmd_line.to_string(), None)
}

/// If there's a trailing pipe command, pipe the result's stdout through it
async fn maybe_pipe_result(result: ShellResult, pipe_rest: Option<String>, env: &mut ShellEnv) -> ShellResult {
    match pipe_rest {
        Some(rest_cmd) if !rest_cmd.is_empty() => {
            // Write the result's stdout to a temp file or pass via command substitution
            // For simplicity, we'll use echo with the output and pipe it
            // This is a bit hacky but works for most cases
            
            // Create a simple pipeline: echo the output and pipe to the rest
            // Use printf to handle special characters better
            let escaped_output = result.stdout.replace('\\', "\\\\").replace('\'', "'\\''");
            let piped_cmd = format!("printf '%s' '{}' | {}", escaped_output, rest_cmd);
            
            let pipe_result = Box::pin(run_pipeline(&piped_cmd, env)).await;
            
            ShellResult {
                stdout: pipe_result.stdout,
                stderr: format!("{}{}", result.stderr, pipe_result.stderr),
                code: pipe_result.code,
            }
        }
        _ => result,
    }
}

/// Try to parse and execute control flow constructs
async fn try_parse_control_flow(cmd_line: &str, env: &mut ShellEnv) -> Option<ShellResult> {
    let trimmed = cmd_line.trim();
    
    // Handle if/then/else/fi
    if trimmed.starts_with("if ") || trimmed.starts_with("if\t") {
        let (control_part, pipe_rest) = split_control_flow_and_pipe(trimmed, "fi");
        let result = execute_if(&control_part, env).await;
        return Some(maybe_pipe_result(result, pipe_rest, env).await);
    }
    
    // Handle for loop
    if trimmed.starts_with("for ") || trimmed.starts_with("for\t") {
        let (control_part, pipe_rest) = split_control_flow_and_pipe(trimmed, "done");
        let result = execute_for(&control_part, env).await;
        return Some(maybe_pipe_result(result, pipe_rest, env).await);
    }
    
    // Handle while loop  
    if trimmed.starts_with("while ") || trimmed.starts_with("while\t") {
        let (control_part, pipe_rest) = split_control_flow_and_pipe(trimmed, "done");
        let result = execute_while(&control_part, env, false).await;
        return Some(maybe_pipe_result(result, pipe_rest, env).await);
    }
    
    // Handle until loop
    if trimmed.starts_with("until ") || trimmed.starts_with("until\t") {
        let (control_part, pipe_rest) = split_control_flow_and_pipe(trimmed, "done");
        let result = execute_while(&control_part, env, true).await;
        return Some(maybe_pipe_result(result, pipe_rest, env).await);
    }
    
    // Handle case statement
    if trimmed.starts_with("case ") || trimmed.starts_with("case\t") {
        let (control_part, pipe_rest) = split_control_flow_and_pipe(trimmed, "esac");
        let result = execute_case(&control_part, env).await;
        return Some(maybe_pipe_result(result, pipe_rest, env).await);
    }
    
    // Handle function definition: name() { body } or function name { body }
    // NOTE: This is the ONLY thing brush-parser can't handle, so this fallback is essential
    if let Some(result) = try_parse_function_def(trimmed, env) {
        return Some(result);
    }
    
    // Handle source/. builtin
    if trimmed.starts_with("source ") || trimmed.starts_with(". ") {
        return Some(execute_source(trimmed, env).await);
    }
    
    None
}

/// Try to parse a function definition
fn try_parse_function_def(cmd_line: &str, env: &mut ShellEnv) -> Option<ShellResult> {
    let trimmed = cmd_line.trim();
    
    // Pattern 1: name() { body }
    if let Some(paren_pos) = trimmed.find("()") {
        let name = trimmed[..paren_pos].trim();
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            let rest = trimmed[paren_pos + 2..].trim();
            if let Some(body) = rest.strip_prefix('{') {
                if let Some(end) = body.rfind('}') {
                    let body_content = body[..end].trim().to_string();
                    env.functions.insert(name.to_string(), body_content);
                    return Some(ShellResult::success(""));
                }
            }
        }
    }
    
    // Pattern 2: function name { body }
    if let Some(rest) = trimmed.strip_prefix("function ") {
        let rest = rest.trim();
        if let Some(brace_pos) = rest.find('{') {
            let name = rest[..brace_pos].trim().trim_end_matches("()");
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                if let Some(end) = rest.rfind('}') {
                    let body_content = rest[brace_pos + 1..end].trim().to_string();
                    env.functions.insert(name.to_string(), body_content);
                    return Some(ShellResult::success(""));
                }
            }
        }
    }
    
    None
}

// NOTE: handle_return and handle_local removed - executor handles these now

/// Execute source/. builtin
async fn execute_source(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
    let path = if let Some(rest) = cmd_line.strip_prefix("source ") {
        rest.trim()
    } else if let Some(rest) = cmd_line.strip_prefix(". ") {
        rest.trim()
    } else {
        return ShellResult::error("source: missing file argument", 1);
    };
    
    // Resolve path
    let full_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{}/{}", env.cwd.to_string_lossy(), path)
    };
    
    // Read and execute the file
    match std::fs::read_to_string(&full_path) {
        Ok(content) => {
            let mut result = ShellResult::success("");
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                result = Box::pin(run_pipeline(line, env)).await;
                if result.code != 0 && env.options.errexit {
                    break;
                }
            }
            result
        }
        Err(e) => ShellResult::error(format!("source: {}: {}", path, e), 1),
    }
}

/// Execute an if/then/else/fi construct
async fn execute_if(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
    // Parse: if condition; then commands; [elif condition; then commands;]* [else commands;] fi
    let parts = parse_if_construct(cmd_line);
    
    match parts {
        Ok((conditions, bodies, else_body)) => {
            let mut combined_stdout = String::new();
            let mut combined_stderr = String::new();
            let mut last_code = 0;
            
            for (condition, body) in conditions.iter().zip(bodies.iter()) {
                // Evaluate condition
                let cond_result = Box::pin(run_pipeline(condition, env)).await;
                
                if cond_result.code == 0 {
                    // Condition true - execute body
                    let result = Box::pin(run_pipeline(body, env)).await;
                    combined_stdout.push_str(&result.stdout);
                    combined_stderr.push_str(&result.stderr);
                    last_code = result.code;
                    
                    return ShellResult {
                        stdout: combined_stdout,
                        stderr: combined_stderr,
                        code: last_code,
                    };
                }
            }
            
            // No condition matched - execute else body if present
            if let Some(else_cmd) = else_body {
                let result = Box::pin(run_pipeline(&else_cmd, env)).await;
                combined_stdout.push_str(&result.stdout);
                combined_stderr.push_str(&result.stderr);
                last_code = result.code;
            }
            
            ShellResult {
                stdout: combined_stdout,
                stderr: combined_stderr,
                code: last_code,
            }
        }
        Err(e) => ShellResult::error(e, 2),
    }
}

/// Parse if/then/else/fi construct into components
fn parse_if_construct(cmd_line: &str) -> Result<(Vec<String>, Vec<String>, Option<String>), String> {
    let mut conditions = Vec::new();
    let mut bodies = Vec::new();
    let mut else_body = None;
    
    // Simple keyword-based parsing
    let normalized = cmd_line
        .replace("; then", " then")
        .replace(";then", " then")
        .replace("; else", " else")
        .replace(";else", " else")
        .replace("; elif", " elif")
        .replace(";elif", " elif")
        .replace("; fi", " fi")
        .replace(";fi", " fi");
    
    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    let mut i = 0;
    
    // Skip initial "if"
    if tokens.get(i) != Some(&"if") {
        return Err("expected 'if'".to_string());
    }
    i += 1;
    
    loop {
        // Collect condition until "then"
        let mut condition = Vec::new();
        while i < tokens.len() && tokens[i] != "then" {
            condition.push(tokens[i]);
            i += 1;
        }
        
        if tokens.get(i) != Some(&"then") {
            return Err("expected 'then'".to_string());
        }
        i += 1; // skip "then"
        
        conditions.push(condition.join(" "));
        
        // Collect body until "elif", "else", or "fi"
        let mut body = Vec::new();
        while i < tokens.len() && !matches!(tokens[i], "elif" | "else" | "fi") {
            body.push(tokens[i]);
            i += 1;
        }
        bodies.push(body.join(" "));
        
        match tokens.get(i) {
            Some(&"elif") => {
                i += 1; // skip "elif", continue loop
            }
            Some(&"else") => {
                i += 1; // skip "else"
                let mut else_parts = Vec::new();
                while i < tokens.len() && tokens[i] != "fi" {
                    else_parts.push(tokens[i]);
                    i += 1;
                }
                else_body = Some(else_parts.join(" "));
                break;
            }
            Some(&"fi") | None => break,
            _ => return Err(format!("unexpected token: {}", tokens[i])),
        }
    }
    
    Ok((conditions, bodies, else_body))
}

/// Execute a for loop
async fn execute_for(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
    // Parse: for var in list; do commands; done
    let parts = parse_for_construct(cmd_line);
    
    match parts {
        Ok((var_name, items, body)) => {
            let mut combined_stdout = String::new();
            let mut combined_stderr = String::new();
            let mut last_code = 0;
            let mut iterations = 0;
            
            for item in items {
                if iterations >= MAX_LOOP_ITERATIONS {
                    return ShellResult::error("maximum loop iterations exceeded", 1);
                }
                iterations += 1;
                
                // Set the loop variable
                if let Err(e) = env.set_var(&var_name, &item) {
                    return ShellResult::error(e, 1);
                }
                
                // Execute body
                let result = Box::pin(run_pipeline(&body, env)).await;
                combined_stdout.push_str(&result.stdout);
                combined_stderr.push_str(&result.stderr);
                last_code = result.code;
                
                // Handle break/continue via exit code magic
                // (simplified - real shell has more complex break/continue)
            }
            
            ShellResult {
                stdout: combined_stdout,
                stderr: combined_stderr,
                code: last_code,
            }
        }
        Err(e) => ShellResult::error(e, 2),
    }
}

/// Parse for loop construct
fn parse_for_construct(cmd_line: &str) -> Result<(String, Vec<String>, String), String> {
    let normalized = cmd_line
        .replace("; do", " do")
        .replace(";do", " do")
        .replace("; done", " done")
        .replace(";done", " done");
    
    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    let mut i = 0;
    
    // Skip "for"
    if tokens.get(i) != Some(&"for") {
        return Err("expected 'for'".to_string());
    }
    i += 1;
    
    // Get variable name
    let var_name = tokens.get(i).ok_or("expected variable name")?.to_string();
    i += 1;
    
    // Expect "in"
    if tokens.get(i) != Some(&"in") {
        return Err("expected 'in'".to_string());
    }
    i += 1;
    
    // Collect items until "do"
    let mut items = Vec::new();
    while i < tokens.len() && tokens[i] != "do" {
        items.push(tokens[i].to_string());
        i += 1;
    }
    
    if tokens.get(i) != Some(&"do") {
        return Err("expected 'do'".to_string());
    }
    i += 1;
    
    // Collect body until "done"
    let mut body = Vec::new();
    while i < tokens.len() && tokens[i] != "done" {
        body.push(tokens[i]);
        i += 1;
    }
    
    Ok((var_name, items, body.join(" ")))
}

/// Execute while or until loop
async fn execute_while(cmd_line: &str, env: &mut ShellEnv, is_until: bool) -> ShellResult {
    let keyword = if is_until { "until" } else { "while" };
    let parts = parse_while_construct(cmd_line, keyword);
    
    match parts {
        Ok((condition, body)) => {
            let mut combined_stdout = String::new();
            let mut combined_stderr = String::new();
            let mut last_code = 0;
            let mut iterations = 0;
            
            loop {
                if iterations >= MAX_LOOP_ITERATIONS {
                    return ShellResult::error("maximum loop iterations exceeded", 1);
                }
                iterations += 1;
                
                // Evaluate condition
                let cond_result = Box::pin(run_pipeline(&condition, env)).await;
                
                // For while: continue if exit code is 0
                // For until: continue if exit code is non-zero
                let should_continue = if is_until {
                    cond_result.code != 0
                } else {
                    cond_result.code == 0
                };
                
                if !should_continue {
                    break;
                }
                
                // Execute body
                let result = Box::pin(run_pipeline(&body, env)).await;
                combined_stdout.push_str(&result.stdout);
                combined_stderr.push_str(&result.stderr);
                last_code = result.code;
            }
            
            ShellResult {
                stdout: combined_stdout,
                stderr: combined_stderr,
                code: last_code,
            }
        }
        Err(e) => ShellResult::error(e, 2),
    }
}

/// Parse while/until loop construct
fn parse_while_construct(cmd_line: &str, keyword: &str) -> Result<(String, String), String> {
    let normalized = cmd_line
        .replace("; do", " do")
        .replace(";do", " do")
        .replace("; done", " done")
        .replace(";done", " done");
    
    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    let mut i = 0;
    
    // Skip keyword
    if tokens.get(i) != Some(&keyword) {
        return Err(format!("expected '{}'", keyword));
    }
    i += 1;
    
    // Collect condition until "do"
    let mut condition = Vec::new();
    while i < tokens.len() && tokens[i] != "do" {
        condition.push(tokens[i]);
        i += 1;
    }
    
    if tokens.get(i) != Some(&"do") {
        return Err("expected 'do'".to_string());
    }
    i += 1;
    
    // Collect body until "done"
    let mut body = Vec::new();
    while i < tokens.len() && tokens[i] != "done" {
        body.push(tokens[i]);
        i += 1;
    }
    
    Ok((condition.join(" "), body.join(" ")))
}

/// Execute case statement
async fn execute_case(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
    // Parse: case word in pattern) commands;; ... esac
    match parse_case_construct(cmd_line) {
        Ok((word, cases)) => {
            // Expand the word
            let expanded_word = match expand_string(&word, env, false) {
                Ok(w) => w,
                Err(e) => return ShellResult::error(e, 1),
            };
            
            for (pattern, body) in cases {
                // Check if pattern matches word (simple glob match)
                if pattern == "*" || glob_match(&pattern, &expanded_word) {
                    return Box::pin(run_pipeline(&body, env)).await;
                }
            }
            
            // No pattern matched
            ShellResult::success("")
        }
        Err(e) => ShellResult::error(e, 2),
    }
}

/// Parse case construct
fn parse_case_construct(cmd_line: &str) -> Result<(String, Vec<(String, String)>), String> {
    // Simplified parsing - real shell case statements are more complex
    let normalized = cmd_line
        .replace(";;", " ;; ")
        .replace("esac", " esac ");
    
    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    let mut i = 0;
    
    // Skip "case"
    if tokens.get(i) != Some(&"case") {
        return Err("expected 'case'".to_string());
    }
    i += 1;
    
    // Get word
    let word = tokens.get(i).ok_or("expected word")?.to_string();
    i += 1;
    
    // Expect "in"
    if tokens.get(i) != Some(&"in") {
        return Err("expected 'in'".to_string());
    }
    i += 1;
    
    let mut cases = Vec::new();
    
    while i < tokens.len() && tokens[i] != "esac" {
        // Get pattern (ends with ')')
        let mut pattern = String::new();
        while i < tokens.len() {
            let tok = tokens[i];
            if tok.ends_with(')') {
                pattern.push_str(&tok[..tok.len()-1]);
                i += 1;
                break;
            }
            pattern.push_str(tok);
            pattern.push(' ');
            i += 1;
        }
        
        // Collect body until ";;"
        let mut body = Vec::new();
        while i < tokens.len() && tokens[i] != ";;" && tokens[i] != "esac" {
            body.push(tokens[i]);
            i += 1;
        }
        
        if tokens.get(i) == Some(&";;") {
            i += 1; // skip ";;"
        }
        
        cases.push((pattern.trim().to_string(), body.join(" ")));
    }
    
    Ok((word, cases))
}

/// Try to parse and execute a variable assignment
/// NOTE: Builtins (export, readonly, unset, set) are now handled by brush-parser + executor
/// This only handles simple VAR=value assignments as fallback
async fn try_parse_assignment(cmd_line: &str, env: &mut ShellEnv) -> Option<ShellResult> {
    let trimmed = cmd_line.trim();
    
    // Check for simple assignment VAR=value (no command)
    if let Some(eq_pos) = trimmed.find('=') {
        let before_eq = &trimmed[..eq_pos];
        // Ensure it's a valid variable name (no spaces before =)
        if !before_eq.is_empty() 
            && !before_eq.contains(' ')
            && before_eq.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
            && before_eq.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            // Check if this is JUST an assignment or assignment + command
            let after_eq_and_value = &trimmed[eq_pos + 1..];
            
            // Find end of value (might be quoted)
            if let Some((value, rest)) = parse_assignment_value(after_eq_and_value) {
                if rest.trim().is_empty() {
                    // Pure assignment
                    let expanded_value = match expand_string(&value, env, false) {
                        Ok(v) => v,
                        Err(e) => return Some(ShellResult::error(e, 1)),
                    };
                    
                    if let Err(e) = env.set_var(before_eq, &expanded_value) {
                        return Some(ShellResult::error(e, 1));
                    }
                    return Some(ShellResult::success(""));
                }
                // Assignment + command: set var for duration of command
                // This would need to save/restore, but for simplicity we just set it
                let expanded_value = match expand_string(&value, env, false) {
                    Ok(v) => v,
                    Err(e) => return Some(ShellResult::error(e, 1)),
                };
                let _ = env.set_var(before_eq, &expanded_value);
                // Continue with rest as command - don't return, fall through
            }
        }
    }
    
    None
}

/// Parse a value from an assignment (handles quoting)
fn parse_assignment_value(s: &str) -> Option<(String, &str)> {
    let s = s.trim_start();
    if s.is_empty() {
        return Some((String::new(), ""));
    }
    
    let mut chars = s.chars().peekable();
    let mut value = String::new();
    
    match chars.peek() {
        Some('"') => {
            chars.next(); // consume opening quote
            while let Some(c) = chars.next() {
                if c == '"' {
                    break;
                } else if c == '\\' {
                    if let Some(next) = chars.next() {
                        value.push(next);
                    }
                } else {
                    value.push(c);
                }
            }
        }
        Some('\'') => {
            chars.next(); // consume opening quote
            while let Some(c) = chars.next() {
                if c == '\'' {
                    break;
                } else {
                    value.push(c);
                }
            }
        }
        _ => {
            // Unquoted - read until whitespace
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                value.push(chars.next().unwrap());
            }
        }
    }
    
    let remaining: String = chars.collect();
    let idx = s.len() - remaining.len();
    Some((value, &s[idx..]))
}
// NOTE: handle_export, handle_readonly, handle_unset, handle_set removed
// These builtins are now handled by brush-parser + executor

/// Split command line by chain operators (&&, ||, ;)
/// Returns Vec of (segment, preceding_operator)
/// This function is control-flow-aware and won't split inside for/while/if/case/until blocks
fn split_by_chain_ops(cmd_line: &str) -> Vec<(&str, Option<ChainOp>)> {
    let mut result = Vec::new();
    let mut segment_start = 0;
    let mut prev_op: Option<ChainOp> = None;
    let mut i = 0;
    let bytes = cmd_line.as_bytes();
    let len = bytes.len();
    
    // Track control flow depth: for/while/until/if/case
    let mut control_depth = 0;
    // Track quote state
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    // Track parenthesis depth for subshells
    let mut paren_depth = 0;
    
    while i < len {
        let c = bytes[i] as char;
        
        // Handle quotes
        if c == '\'' && !in_double_quote {
            in_single_quote = !in_single_quote;
            i += 1;
            continue;
        }
        if c == '"' && !in_single_quote {
            in_double_quote = !in_double_quote;
            i += 1;
            continue;
        }
        
        // Skip if inside quotes
        if in_single_quote || in_double_quote {
            i += 1;
            continue;
        }
        
        // Track parentheses
        if c == '(' {
            paren_depth += 1;
            i += 1;
            continue;
        }
        if c == ')' {
            if paren_depth > 0 {
                paren_depth -= 1;
            }
            i += 1;
            continue;
        }
        
        // Skip if inside parentheses (subshell)
        if paren_depth > 0 {
            i += 1;
            continue;
        }
        
        // Check for control flow keywords (need word boundaries)
        let remaining = &cmd_line[i..];
        
        // Control flow start keywords: for, while, until, if, case
        if (remaining.starts_with("for ") || remaining.starts_with("for\t") ||
            remaining.starts_with("while ") || remaining.starts_with("while\t") ||
            remaining.starts_with("until ") || remaining.starts_with("until\t") ||
            remaining.starts_with("if ") || remaining.starts_with("if\t") ||
            remaining.starts_with("case ") || remaining.starts_with("case\t")) &&
           (i == 0 || !bytes[i-1].is_ascii_alphanumeric()) {
            control_depth += 1;
            i += 1;
            continue;
        }
        
        // Control flow end keywords: done, fi, esac (with word boundary check)
        if remaining.starts_with("done") || remaining.starts_with("fi") || remaining.starts_with("esac") {
            let keyword_len = if remaining.starts_with("done") { 4 } 
                             else if remaining.starts_with("esac") { 4 }
                             else { 2 };
            // Check if it's a complete word (followed by non-alnum or end of string)
            if i + keyword_len >= len || !bytes[i + keyword_len].is_ascii_alphanumeric() {
                if control_depth > 0 {
                    control_depth -= 1;
                }
                i += keyword_len;
                continue;
            }
        }
        
        // Only split on chain operators when control_depth == 0
        if control_depth == 0 {
            // Check for && 
            if remaining.starts_with("&&") {
                let segment = &cmd_line[segment_start..i];
                if !segment.trim().is_empty() {
                    result.push((segment, prev_op));
                }
                prev_op = Some(ChainOp::And);
                i += 2;
                segment_start = i;
                continue;
            }
            
            // Check for || (but not inside single |)
            if remaining.starts_with("||") {
                let segment = &cmd_line[segment_start..i];
                if !segment.trim().is_empty() {
                    result.push((segment, prev_op));
                }
                prev_op = Some(ChainOp::Or);
                i += 2;
                segment_start = i;
                continue;
            }
            
            // Check for ; (but skip single | which is pipe)
            if c == ';' {
                let segment = &cmd_line[segment_start..i];
                if !segment.trim().is_empty() {
                    result.push((segment, prev_op));
                }
                prev_op = Some(ChainOp::Seq);
                i += 1;
                segment_start = i;
                continue;
            }
        }
        
        i += 1;
    }
    
    // Push remaining segment
    let remaining_segment = &cmd_line[segment_start..];
    if !remaining_segment.trim().is_empty() {
        result.push((remaining_segment, prev_op));
    }
    
    result
}

/// Run a single pipeline (handles | only, no &&/||/;)
pub async fn run_single_pipeline(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
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

    // Parse each command with redirections, variable expansion, and brace expansion
    let mut commands: Vec<(String, Vec<String>, Redirects)> = Vec::new();
    for part in &pipeline_parts {
        let part = part.trim();
        
        // First expand variables in the raw string
        let expanded_part = match expand_string(part, env, false) {
            Ok(s) => s,
            Err(e) => return ShellResult::error(e, 1),
        };
        
        // Check for command substitution markers and execute them
        let final_part = execute_command_substitutions(&expanded_part, env).await;
        
        match shlex::split(&final_part) {
            Some(tokens) if !tokens.is_empty() => {
                let cmd_name = tokens[0].clone();
                // Parse redirections first
                let (remaining_tokens, redirects) = parse_redirects(tokens[1..].to_vec());
                
                // Expand braces, then globs
                let mut expanded_args = Vec::new();
                for arg in &remaining_tokens {
                    let brace_expanded = expand_braces(arg);
                    for brace_arg in brace_expanded {
                        expanded_args.push(brace_arg);
                    }
                }
                let args = expand_globs(&expanded_args, &env.cwd.to_string_lossy());
                
                // Print xtrace if enabled
                if env.options.xtrace {
                    let trace_line = format!("+ {} {}\n", cmd_name, args.join(" "));
                    // We can't easily write to stderr here, so we'll prepend to output later
                    eprintln!("{}", trace_line.trim());
                }
                
                commands.push((cmd_name, args, redirects));
            }
            _ => {
                return ShellResult::error(format!("Parse error: {}", part), 1);
            }
        }
    }

    // Handle special built-in commands that modify the environment
    // These must be handled before command dispatch because they mutate env
    if num_commands == 1 {
        let (cmd_name, ref args, _) = &commands[0];
        match cmd_name.as_str() {
            "cd" => {
                return handle_cd(args, env);
            }
            "pushd" => {
                return handle_pushd(args, env);
            }
            "popd" => {
                return handle_popd(args, env);
            }
            "dirs" => {
                return handle_dirs(args, env);
            }
            _ => {}
        }
    }

    // Verify all commands exist (or are functions)
    for (cmd_name, _, _) in &commands {
        if !is_builtin(cmd_name) 
            && ShellCommands::get_command(cmd_name).is_none()
            && !env.functions.contains_key(cmd_name)
        {
            return ShellResult::error(format!("{}: command not found", cmd_name), 127);
        }
    }

    // Create stderr channel for all commands to share
    let (stderr_tx, _stderr_rx) = async_channel::bounded::<Vec<u8>>(16);

    // For a single command, we run it directly
    if num_commands == 1 {
        let (cmd_name, args, redirects) = commands.into_iter().next().unwrap();
        
        // Check if this is a user-defined function
        if let Some(body) = env.functions.get(&cmd_name).cloned() {
            // Execute function
            let old_params = std::mem::replace(&mut env.positional_params, args);
            let old_in_function = env.in_function;
            let old_local_vars = std::mem::take(&mut env.local_vars);
            env.in_function = true;
            
            let result = Box::pin(run_pipeline(&body, env)).await;
            
            // Restore state
            env.positional_params = old_params;
            env.in_function = old_in_function;
            env.local_vars = old_local_vars;
            
            return result;
        }
        
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

        // Check if it's a user-defined function
        let code = if let Some(body) = env.functions.get(&cmd_name).cloned() {
            // Execute function - save and restore params
            let old_params = std::mem::replace(&mut env.positional_params, args);
            let old_in_function = env.in_function;
            let old_local_vars = std::mem::take(&mut env.local_vars);
            env.in_function = true;
            
            // If there's stdin data, pipe it to the function body
            let result = if !current_input.is_empty() {
                // Escape the input for printf
                let input_str = String::from_utf8_lossy(&current_input);
                let escaped = input_str.replace('\\', "\\\\").replace('\'', "'\\''");
                let piped_body = format!("printf '%s' '{}' | {}", escaped, body);
                Box::pin(run_pipeline(&piped_body, env)).await
            } else {
                Box::pin(run_pipeline(&body, env)).await
            };
            
            // Restore state
            env.positional_params = old_params;
            env.in_function = old_in_function;
            env.local_vars = old_local_vars;
            
            // Write function output to stdout
            let _ = piper::Writer::from(stdout_writer);
            // Note: Function output goes to ShellResult, need to collect it
            current_input = result.stdout.into_bytes();
            all_stderr.extend(result.stderr.into_bytes());
            
            result.code
        } else if let Some(cmd_fn) = ShellCommands::get_command(&cmd_name) {
            // Run built-in command
            let code = cmd_fn(args, env, stdin_reader, stdout_writer, stderr_writer).await;
            
            // Capture outputs
            current_input = drain_reader(stdout_reader).await;
            let cmd_stderr = drain_reader(stderr_reader).await;
            all_stderr.extend(cmd_stderr);
            
            code
        } else {
            // Should not happen - we validated commands earlier
            -1
        };

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
#[allow(dead_code)] // convenience wrapper for simple commands
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

    #[test]
    fn test_cd_basic() {
        let mut env = ShellEnv::new();
        // Start at /
        assert_eq!(env.cwd.to_string_lossy(), "/");
        
        // cd to /tmp (using test VFS path)
        let result = futures_lite::future::block_on(run_pipeline("cd /", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.cwd.to_string_lossy(), "/");
    }

    #[test]
    fn test_cd_then_pwd() {
        let mut env = ShellEnv::new();
        // Create a test directory first
        let _ = std::fs::create_dir_all("/tmp/test_cd");
        
        // cd to /tmp/test_cd
        let result = futures_lite::future::block_on(run_pipeline("cd /tmp/test_cd", &mut env));
        assert_eq!(result.code, 0);
        
        // pwd should now show /tmp/test_cd
        let result = futures_lite::future::block_on(run_pipeline("pwd", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "/tmp/test_cd");
        
        // Cleanup
        let _ = std::fs::remove_dir("/tmp/test_cd");
    }

    #[test]
    fn test_cd_relative_path() {
        let mut env = ShellEnv::new();
        // Create test directories
        let _ = std::fs::create_dir_all("/tmp/testdir/subdir");
        
        // cd to /tmp
        let result = futures_lite::future::block_on(run_pipeline("cd /tmp", &mut env));
        assert_eq!(result.code, 0);
        
        // cd to relative path testdir
        let result = futures_lite::future::block_on(run_pipeline("cd testdir", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/testdir");
        
        // cd to subdir
        let result = futures_lite::future::block_on(run_pipeline("cd subdir", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/testdir/subdir");
        
        // Cleanup
        let _ = std::fs::remove_dir_all("/tmp/testdir");
    }

    #[test]
    fn test_cd_dotdot() {
        let mut env = ShellEnv::new();
        // Create test directories
        let _ = std::fs::create_dir_all("/tmp/a/b/c");
        
        // cd to /tmp/a/b/c
        let result = futures_lite::future::block_on(run_pipeline("cd /tmp/a/b/c", &mut env));
        assert_eq!(result.code, 0);
        
        // cd .. should go to /tmp/a/b
        let result = futures_lite::future::block_on(run_pipeline("cd ..", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/a/b");
        
        // cd ../.. should go to /tmp
        let result = futures_lite::future::block_on(run_pipeline("cd ../..", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.cwd.to_string_lossy(), "/tmp");
        
        // Cleanup
        let _ = std::fs::remove_dir_all("/tmp/a");
    }

    #[test]
    fn test_cd_dash() {
        let mut env = ShellEnv::new();
        let _ = std::fs::create_dir_all("/tmp/dir1");
        let _ = std::fs::create_dir_all("/tmp/dir2");
        
        // Start at /
        futures_lite::future::block_on(run_pipeline("cd /tmp/dir1", &mut env));
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/dir1");
        
        // cd to dir2
        futures_lite::future::block_on(run_pipeline("cd /tmp/dir2", &mut env));
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/dir2");
        
        // cd - should go back to dir1
        futures_lite::future::block_on(run_pipeline("cd -", &mut env));
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/dir1");
        
        // cd - again should go back to dir2
        futures_lite::future::block_on(run_pipeline("cd -", &mut env));
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/dir2");
        
        // Cleanup
        let _ = std::fs::remove_dir_all("/tmp/dir1");
        let _ = std::fs::remove_dir_all("/tmp/dir2");
    }

    #[test]
    fn test_cd_interleaved_with_commands() {
        let mut env = ShellEnv::new();
        let _ = std::fs::create_dir_all("/tmp/cdtest");
        let _ = std::fs::write("/tmp/cdtest/file.txt", "hello");
        
        // cd then pwd
        futures_lite::future::block_on(run_pipeline("cd /tmp/cdtest", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("pwd", &mut env));
        assert_eq!(result.stdout.trim(), "/tmp/cdtest");
        
        // Run ls equivalent (cat a known file to verify we're in right dir)
        let result = futures_lite::future::block_on(run_pipeline("cat file.txt", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "hello");
        
        // cd .. then pwd again
        futures_lite::future::block_on(run_pipeline("cd ..", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("pwd", &mut env));
        assert_eq!(result.stdout.trim(), "/tmp");
        
        // Cleanup
        let _ = std::fs::remove_dir_all("/tmp/cdtest");
    }

    #[test]
    fn test_cd_with_chain_operators() {
        let mut env = ShellEnv::new();
        let _ = std::fs::create_dir_all("/tmp/chaintest");
        
        // cd && pwd should work
        let result = futures_lite::future::block_on(run_pipeline("cd /tmp/chaintest && pwd", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "/tmp/chaintest");
        
        // Cleanup
        let _ = std::fs::remove_dir_all("/tmp/chaintest");
    }

    #[test]
    fn test_pushd_popd() {
        let mut env = ShellEnv::new();
        let _ = std::fs::create_dir_all("/tmp/pushd1");
        let _ = std::fs::create_dir_all("/tmp/pushd2");
        
        // Start at /
        assert_eq!(env.cwd.to_string_lossy(), "/");
        
        // pushd /tmp/pushd1
        let result = futures_lite::future::block_on(run_pipeline("pushd /tmp/pushd1", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/pushd1");
        assert_eq!(env.dir_stack.len(), 1);
        
        // pushd /tmp/pushd2
        let result = futures_lite::future::block_on(run_pipeline("pushd /tmp/pushd2", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/pushd2");
        assert_eq!(env.dir_stack.len(), 2);
        
        // popd should go back to /tmp/pushd1
        let result = futures_lite::future::block_on(run_pipeline("popd", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.cwd.to_string_lossy(), "/tmp/pushd1");
        assert_eq!(env.dir_stack.len(), 1);
        
        // popd should go back to /
        let result = futures_lite::future::block_on(run_pipeline("popd", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.cwd.to_string_lossy(), "/");
        assert_eq!(env.dir_stack.len(), 0);
        
        // Cleanup
        let _ = std::fs::remove_dir_all("/tmp/pushd1");
        let _ = std::fs::remove_dir_all("/tmp/pushd2");
    }

    #[test]
    fn test_dirs() {
        let mut env = ShellEnv::new();
        let _ = std::fs::create_dir_all("/tmp/dirstest");
        
        // dirs with empty stack
        let result = futures_lite::future::block_on(run_pipeline("dirs", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "/");
        
        // pushd and check dirs
        futures_lite::future::block_on(run_pipeline("pushd /tmp/dirstest", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("dirs", &mut env));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("/tmp/dirstest"));
        assert!(result.stdout.contains("/"));
        
        // Cleanup
        let _ = std::fs::remove_dir_all("/tmp/dirstest");
    }

    #[test]
    fn test_cd_nonexistent() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("cd /nonexistent/path", &mut env));
        assert_eq!(result.code, 1);
        assert!(result.stderr.contains("No such file or directory"));
    }

    // ========================================================================
    // Variable Assignment Tests
    // ========================================================================

    #[test]
    fn test_variable_assignment() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("FOO=bar", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.get_var("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn test_variable_expansion_echo() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("MSG=hello", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("echo $MSG", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "hello");
    }

    #[test]
    fn test_export_var() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("export MY_VAR=exported", &mut env));
        assert_eq!(result.code, 0);
        assert!(env.env_vars.contains_key("MY_VAR"));
        assert_eq!(env.env_vars.get("MY_VAR"), Some(&"exported".to_string()));
    }

    #[test]
    fn test_unset_var() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("TO_REMOVE", "value");
        assert!(env.get_var("TO_REMOVE").is_some());
        
        let result = futures_lite::future::block_on(run_pipeline("unset TO_REMOVE", &mut env));
        assert_eq!(result.code, 0);
        assert!(env.get_var("TO_REMOVE").is_none());
    }

    #[test]
    fn test_readonly_var() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("readonly IMMUTABLE=fixed", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(env.get_var("IMMUTABLE"), Some(&"fixed".to_string()));
        
        // Trying to change should fail
        let result = futures_lite::future::block_on(run_pipeline("IMMUTABLE=changed", &mut env));
        assert_ne!(result.code, 0);
    }

    // ========================================================================
    // Control Flow Tests
    // ========================================================================

    #[test]
    fn test_if_true() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline(
            "if test 1 -eq 1; then echo yes; fi", 
            &mut env
        ));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("yes"));
    }

    #[test]
    fn test_if_false() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline(
            "if test 1 -eq 2; then echo yes; fi", 
            &mut env
        ));
        assert_eq!(result.code, 0);
        assert!(!result.stdout.contains("yes"));
    }

    #[test]
    fn test_if_else() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline(
            "if test 1 -eq 2; then echo yes; else echo no; fi", 
            &mut env
        ));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("no"));
    }

    #[test]
    fn test_for_loop() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline(
            "for i in a b c; do echo $i; done", 
            &mut env
        ));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("a"));
        assert!(result.stdout.contains("b"));
        assert!(result.stdout.contains("c"));
    }

    // ========================================================================
    // Set Command Tests
    // ========================================================================

    #[test]
    fn test_set_errexit() {
        let mut env = ShellEnv::new();
        assert!(!env.options.errexit);
        
        let result = futures_lite::future::block_on(run_pipeline("set -e", &mut env));
        assert_eq!(result.code, 0);
        assert!(env.options.errexit);
        
        let result = futures_lite::future::block_on(run_pipeline("set +e", &mut env));
        assert_eq!(result.code, 0);
        assert!(!env.options.errexit);
    }

    #[test]
    fn test_set_nounset() {
        let mut env = ShellEnv::new();
        assert!(!env.options.nounset);
        
        let result = futures_lite::future::block_on(run_pipeline("set -u", &mut env));
        assert_eq!(result.code, 0);
        assert!(env.options.nounset);
    }

    #[test]
    fn test_set_xtrace() {
        let mut env = ShellEnv::new();
        assert!(!env.options.xtrace);
        
        let result = futures_lite::future::block_on(run_pipeline("set -x", &mut env));
        assert_eq!(result.code, 0);
        assert!(env.options.xtrace);
    }

    #[test]
    fn test_set_pipefail() {
        let mut env = ShellEnv::new();
        assert!(!env.options.pipefail);
        
        let result = futures_lite::future::block_on(run_pipeline("set -o pipefail", &mut env));
        assert_eq!(result.code, 0);
        assert!(env.options.pipefail);
    }

    // ========================================================================
    // Brace Expansion Tests in Pipeline
    // ========================================================================

    #[test]
    fn test_brace_expansion_pipeline() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo {a,b,c}", &mut env));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("a"));
        assert!(result.stdout.contains("b"));
        assert!(result.stdout.contains("c"));
    }

    #[test]
    fn test_range_expansion_pipeline() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo {1..3}", &mut env));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("1"));
        assert!(result.stdout.contains("2"));
        assert!(result.stdout.contains("3"));
    }

    // ========================================================================
    // Test Command Integration
    // ========================================================================

    #[test]
    fn test_test_command() {
        let mut env = ShellEnv::new();
        
        // True case
        let result = futures_lite::future::block_on(run_pipeline("test -n hello", &mut env));
        assert_eq!(result.code, 0);
        
        // False case
        let result = futures_lite::future::block_on(run_pipeline("test -z hello", &mut env));
        assert_eq!(result.code, 1);
    }

    #[test]
    fn test_bracket_command() {
        let mut env = ShellEnv::new();
        
        // True case
        let result = futures_lite::future::block_on(run_pipeline("[ 5 -gt 3 ]", &mut env));
        assert_eq!(result.code, 0);
        
        // False case
        let result = futures_lite::future::block_on(run_pipeline("[ 3 -gt 5 ]", &mut env));
        assert_eq!(result.code, 1);
    }

    // ========================================================================
    // New Commands Integration
    // ========================================================================

    #[test]
    fn test_printf_command() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("printf 'Hello %s!' world", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout, "Hello world!");
    }

    #[test]
    fn test_base64_encode() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo -n 'Hello' | base64", &mut env));
        assert_eq!(result.code, 0);
        assert!(result.stdout.trim().contains("SGVsbG8"));
    }

    #[test]
    fn test_type_command() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("type echo", &mut env));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("builtin"));
    }

    #[test]
    fn test_type_not_found() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("type nonexistent_cmd", &mut env));
        assert_eq!(result.code, 1);
    }

    // ========================================================================
    // Function Definition and Invocation Tests
    // ========================================================================

    #[test]
    fn test_function_definition_simple() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("greet() { echo hello }", &mut env));
        assert_eq!(result.code, 0);
        assert!(env.functions.contains_key("greet"));
    }

    #[test]
    fn test_function_invocation() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("greet() { echo hello }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("greet", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "hello");
    }

    #[test]
    fn test_function_with_args() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("greet() { echo Hello $1 }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("greet World", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "Hello World");
    }

    #[test]
    fn test_function_multiple_args() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("add_prefix() { echo $1-$2 }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("add_prefix foo bar", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "foo-bar");
    }

    #[test]
    fn test_function_keyword_syntax() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("function myfunc { echo test }", &mut env));
        assert_eq!(result.code, 0);
        assert!(env.functions.contains_key("myfunc"));
    }

    #[test]
    fn test_local_variable_scope() {
        let mut env = ShellEnv::new();
        // Set outer var first
        futures_lite::future::block_on(run_pipeline("x=outer", &mut env));
        // Define function with local var - note the local is in the function body
        futures_lite::future::block_on(run_pipeline("test_local() { local x=inner; echo local_was_set }", &mut env));
        // Call function
        let result = futures_lite::future::block_on(run_pipeline("test_local", &mut env));
        // Just verify function ran
        assert!(result.stdout.contains("local_was_set") || result.code == 0);
        // Outer var should be preserved  
        assert_eq!(env.get_var("x"), Some(&"outer".to_string()));
    }

    #[test]
    fn test_return_from_function() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("check_status() { return 42 }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("check_status", &mut env));
        assert_eq!(result.code, 42);
    }

    #[test]
    fn test_return_outside_function() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("return 0", &mut env));
        assert_eq!(result.code, 1); // Should error
        assert!(result.stderr.contains("return"));
    }

    #[test]
    fn test_local_outside_function() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("local x=1", &mut env));
        assert_eq!(result.code, 1); // Should error
        assert!(result.stderr.contains("function"));
    }

    // ========================================================================
    // Here-String Tests
    // ========================================================================

    #[test]
    fn test_here_string_parsing() {
        // Test that here-string tokens are recognized in parse_redirects
        let tokens = vec!["<<<".to_string(), "test".to_string()];
        let (args, redirects) = parse_redirects(tokens);
        assert!(args.is_empty());
        assert_eq!(redirects.herestring, Some("test".to_string()));
    }

    #[test]
    fn test_here_string_no_space() {
        let tokens = vec!["<<<test".to_string()];
        let (args, redirects) = parse_redirects(tokens);
        assert!(args.is_empty());
        assert_eq!(redirects.herestring, Some("test".to_string()));
    }

    // ========================================================================
    // Pipeline Compositions with New Commands
    // ========================================================================

    #[test]
    fn test_echo_to_rev() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo hello | rev", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "olleh");
    }

    #[test]
    fn test_echo_to_fold() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo abcdefghij | fold -w 5", &mut env));
        assert_eq!(result.code, 0);
        // Should be wrapped at 5 chars
        let lines: Vec<&str> = result.stdout.lines().collect();
        assert!(lines.len() >= 2);
    }

    #[test]
    fn test_seq_to_shuf() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("seq 1 5 | shuf", &mut env));
        assert_eq!(result.code, 0);
        // Should have 5 lines (in some order)
        let lines: Vec<&str> = result.stdout.lines().collect();
        assert_eq!(lines.len(), 5);
    }

    #[test]
    fn test_echo_to_nl() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo -e 'a\\nb\\nc' | nl", &mut env));
        assert_eq!(result.code, 0);
        // Should have numbered lines
        assert!(result.stdout.contains("1"));
    }

    #[test]
    fn test_grep_to_wc() {
        let mut env = ShellEnv::new();
        let _ = std::fs::write("/tmp/greptest.txt", "hello\nworld\nhello again\n");
        let result = futures_lite::future::block_on(run_pipeline("grep hello /tmp/greptest.txt | wc -l", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "2");
        let _ = std::fs::remove_file("/tmp/greptest.txt");
    }

    #[test]
    fn test_sort_uniq_pipeline() {
        let mut env = ShellEnv::new();
        // Use file-based input instead of echo -e
        let _ = std::fs::write("/tmp/sortuniq.txt", "b\na\nb\nc\na\n");
        let result = futures_lite::future::block_on(run_pipeline("cat /tmp/sortuniq.txt | sort | uniq", &mut env));
        assert_eq!(result.code, 0);
        let lines: Vec<&str> = result.stdout.lines().collect();
        assert_eq!(lines.len(), 3); // a, b, c
        let _ = std::fs::remove_file("/tmp/sortuniq.txt");
    }

    #[test]
    fn test_cut_sort_pipeline() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo -e 'c:3\\na:1\\nb:2' | cut -d: -f1 | sort", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "a\nb\nc");
    }

    #[test]
    fn test_tr_pipeline() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo hello | tr 'a-z' 'A-Z'", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "HELLO");
    }

    // ========================================================================
    // Complex Compositions
    // ========================================================================

    #[test]
    fn test_variable_in_pipeline() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("MSG=hello", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("echo $MSG | rev", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "olleh");
    }

    #[test]
    fn test_function_in_pipeline() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("upper() { tr 'a-z' 'A-Z' }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("echo hello | upper", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "HELLO");
    }

    #[test]
    fn test_special_var_in_echo() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo $HOME", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "/");
    }

    #[test]
    fn test_random_in_expr() {
        let mut env = ShellEnv::new();
        // Use RANDOM in a command
        let result = futures_lite::future::block_on(run_pipeline("echo $RANDOM", &mut env));
        assert_eq!(result.code, 0);
        let num: u16 = result.stdout.trim().parse().expect("should be number");
        assert!(num <= 32767);
    }

    #[test]
    fn test_conditional_with_test() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("if test -n hello; then echo yes; fi", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "yes");
    }

    #[test]
    fn test_for_loop_with_pipeline() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("for x in a b c; do echo $x; done | wc -l", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "3");
    }

    #[test]
    fn test_nested_command_sub() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("MSG=world", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("echo Hello $(echo $MSG)", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "Hello world");
    }

    #[test]
    fn test_arithmetic_with_random() {
        let mut env = ShellEnv::new();
        // RANDOM mod 10 should give 0-9
        let result = futures_lite::future::block_on(run_pipeline("echo $(($RANDOM % 10))", &mut env));
        assert_eq!(result.code, 0);
        let num: i32 = result.stdout.trim().parse().expect("should be number");
        assert!(num >= 0 && num < 10);
    }

    // ========================================================================
    // Edge Cases - Error Handling
    // ========================================================================

    #[test]
    fn test_undefined_function() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("undefined_func", &mut env));
        assert_eq!(result.code, 127);
        assert!(result.stderr.contains("not found"));
    }

    #[test]
    fn test_empty_function_body() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("empty() { }", &mut env));
        assert_eq!(result.code, 0);
        let result = futures_lite::future::block_on(run_pipeline("empty", &mut env));
        assert_eq!(result.code, 0);
    }

    #[test]
    fn test_function_overwrites_previous() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("myfn() { echo first }", &mut env));
        futures_lite::future::block_on(run_pipeline("myfn() { echo second }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("myfn", &mut env));
        assert_eq!(result.stdout.trim(), "second");
    }

    #[test]
    fn test_chained_and_or_with_functions() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("ok() { true }", &mut env));
        futures_lite::future::block_on(run_pipeline("fail() { false }", &mut env));
        
        let result = futures_lite::future::block_on(run_pipeline("ok && echo yes", &mut env));
        assert_eq!(result.stdout.trim(), "yes");
        
        let result = futures_lite::future::block_on(run_pipeline("fail || echo fallback", &mut env));
        assert_eq!(result.stdout.trim(), "fallback");
    }

    // ========================================================================
    // Echo Flag Regression Tests
    // ========================================================================

    #[test]
    fn test_echo_e_newline() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo -e 'a\\nb'", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout, "a\nb\n");
    }

    #[test]
    fn test_echo_e_tab() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo -e 'a\\tb'", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout, "a\tb\n");
    }

    #[test]
    fn test_echo_n_no_newline() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo -n hello", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout, "hello");
    }

    #[test]
    fn test_echo_en_combined() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("echo -en 'a\\nb'", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout, "a\nb");
    }

    // ========================================================================
    // Control Flow Piping Regression Tests
    // ========================================================================

    // TODO: This test requires a proper lexer to handle semicolons inside control
    // flow bodies with arithmetic expressions. The current ad-hoc parsing struggles
    // with complex compositions like `x=0; while ...; do echo $x; x=$((x+1)); done | wc`.
    // A tokenizer-based approach would correctly track semicolons vs operators vs parens.
    #[test]
    fn test_while_loop_piping() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("x=0; while [ $x -lt 3 ]; do echo $x; x=$((x+1)); done | wc -l", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "3");
    }

    #[test]
    fn test_while_loop_simple() {
        // Super simple test - just a single statement in body
        let mut env = ShellEnv::new();
        env.set_var("x", "0");
        // Just a single echo, no semicolon
        let result = futures_lite::future::block_on(run_pipeline("while [ $x -lt 1 ]; do echo $x; x=1; done", &mut env));
        assert_eq!(result.code, 0, "stderr: {}", result.stderr);
        assert!(result.stdout.contains("0"), "stdout: {}", result.stdout);
    }

    #[test]
    fn test_if_then_piping() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("if true; then echo hello world; fi | wc -w", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "2");
    }

    #[test]
    fn test_for_loop_complex_body() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("for x in 1 2 3; do echo item_$x; done | grep item_2", &mut env));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("item_2"));
    }

    // ========================================================================
    // Function Feature Regression Tests
    // ========================================================================

    #[test]
    fn test_function_with_echo() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("greet() { echo Hello $1 }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("greet World", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "Hello World");
    }

    #[test]
    fn test_function_chain() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("a() { echo a }", &mut env));
        futures_lite::future::block_on(run_pipeline("b() { echo b }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("a && b", &mut env));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("a"));
        assert!(result.stdout.contains("b"));
    }

    #[test]
    fn test_function_return_zero() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("ok() { return 0 }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("ok", &mut env));
        assert_eq!(result.code, 0);
    }

    #[test]
    fn test_function_return_nonzero() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("fail() { return 5 }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("fail", &mut env));
        assert_eq!(result.code, 5);
    }

    // ========================================================================
    // Combined Feature Tests
    // ========================================================================

    #[test]
    fn test_function_with_for_loop() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("count() { for i in a b c; do echo $i; done }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("count | wc -l", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "3");
    }

    #[test]
    fn test_arithmetic_in_for_loop() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_pipeline("for i in 1 2 3; do echo $((i * 2)); done", &mut env));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("2"));
        assert!(result.stdout.contains("4"));
        assert!(result.stdout.contains("6"));
    }

    #[test]
    fn test_variable_in_function_body() {
        let mut env = ShellEnv::new();
        futures_lite::future::block_on(run_pipeline("PREFIX=hello", &mut env));
        futures_lite::future::block_on(run_pipeline("greet() { echo $PREFIX world }", &mut env));
        let result = futures_lite::future::block_on(run_pipeline("greet", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "hello world");
    }

    #[test]
    fn test_special_var_in_arithmetic() {
        let mut env = ShellEnv::new();
        env.subshell_depth = 2;
        let result = futures_lite::future::block_on(run_pipeline("echo $(($SHLVL + 1))", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "3");
    }
}

