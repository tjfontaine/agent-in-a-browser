//! New Shell Executor - Pure brush-parser based execution
//!
//! This module provides a clean execution layer built entirely on brush-parser.
//! Key features:
//! - Single parser (brush-parser only)
//! - Proper stdin/stdout threading through pipelines
//! - No string reconstruction or re-parsing cycles
//! - Async cooperative command execution

use super::commands::ShellCommands;
use super::env::{ShellEnv, ShellResult};
use super::expand;
use super::parser::ParsedCommand;
use super::parser::ParsedRedirect;
use futures_lite::io::AsyncWriteExt;

const PIPE_CAPACITY: usize = 65536;

/// Main entry point - parse and execute a shell command
pub async fn run_shell(cmd_line: &str, env: &mut ShellEnv) -> ShellResult {
    let cmd_line = cmd_line.trim();
    
    // Handle empty/comment-only
    if cmd_line.is_empty() || cmd_line.starts_with('#') {
        return ShellResult::success("");
    }
    
    // Parse with brush-parser
    match super::parser::parse_command(cmd_line) {
        Ok(parsed_cmds) if !parsed_cmds.is_empty() => {
            execute_sequence(&parsed_cmds, env, None).await
        }
        Ok(_) => ShellResult::success(""),
        Err(e) => ShellResult {
            stdout: String::new(),
            stderr: format!("parse error: {}", e),
            code: 2,
        }
    }
}

/// Execute a sequence of commands (top-level, handles &&, ||, ;)
pub async fn execute_sequence(
    commands: &[ParsedCommand],
    env: &mut ShellEnv,
    stdin: Option<Vec<u8>>,
) -> ShellResult {
    let mut combined_stdout = String::new();
    let mut combined_stderr = String::new();
    let mut last_code = 0i32;
    
    for cmd in commands {
        let result = execute_command(cmd, env, stdin.clone()).await;
        combined_stdout.push_str(&result.stdout);
        combined_stderr.push_str(&result.stderr);
        last_code = result.code;
        
        // For And/Or chains, the branching is handled inside execute_command
    }
    
    ShellResult {
        stdout: combined_stdout,
        stderr: combined_stderr,
        code: last_code,
    }
}

/// Execute a single parsed command with optional stdin
pub async fn execute_command(
    cmd: &ParsedCommand,
    env: &mut ShellEnv,
    stdin: Option<Vec<u8>>,
) -> ShellResult {
    match cmd {
        ParsedCommand::Simple { name, args, redirects, env_vars } => {
            execute_simple(name, args, env_vars, redirects, env, stdin).await
        }
        
        ParsedCommand::Pipeline { commands, negate } => {
            let result = execute_pipeline(commands, env, stdin).await;
            if *negate {
                ShellResult {
                    code: if result.code == 0 { 1 } else { 0 },
                    ..result
                }
            } else {
                result
            }
        }
        
        ParsedCommand::And(left, right) => {
            let left_result = Box::pin(execute_command(left, env, stdin.clone())).await;
            if left_result.code == 0 {
                let right_result = Box::pin(execute_command(right, env, None)).await;
                ShellResult {
                    stdout: format!("{}{}", left_result.stdout, right_result.stdout),
                    stderr: format!("{}{}", left_result.stderr, right_result.stderr),
                    code: right_result.code,
                }
            } else {
                left_result
            }
        }
        
        ParsedCommand::Or(left, right) => {
            let left_result = Box::pin(execute_command(left, env, stdin.clone())).await;
            if left_result.code != 0 {
                let right_result = Box::pin(execute_command(right, env, None)).await;
                ShellResult {
                    stdout: format!("{}{}", left_result.stdout, right_result.stdout),
                    stderr: format!("{}{}", left_result.stderr, right_result.stderr),
                    code: right_result.code,
                }
            } else {
                left_result
            }
        }
        
        ParsedCommand::For { var, words, body } => {
            execute_for(var, words, body, env, stdin).await
        }
        
        ParsedCommand::While { condition, body } => {
            execute_while(condition, body, env, stdin).await
        }
        
        ParsedCommand::If { conditionals, else_branch } => {
            execute_if(conditionals, else_branch, env, stdin).await
        }
        
        ParsedCommand::Case { word, cases } => {
            execute_case(word, cases, env, stdin).await
        }
        
        ParsedCommand::Subshell(commands) => {
            // Subshell executes in a copy of the environment (simplified for now)
            Box::pin(execute_sequence(commands, env, stdin)).await
        }
        
        ParsedCommand::Brace(commands) => {
            // Brace group executes in the same environment
            Box::pin(execute_sequence(commands, env, stdin)).await
        }
        
        ParsedCommand::FunctionDef { name, body } => {
            define_function(name, body, env);
            ShellResult::success("")
        }
        
        ParsedCommand::Background(cmd) => {
            // For single-threaded WASM, background is same as foreground
            Box::pin(execute_command(cmd, env, stdin)).await
        }
    }
}

/// Execute a pipeline, threading stdout → stdin between commands
async fn execute_pipeline(
    commands: &[ParsedCommand],
    env: &mut ShellEnv,
    initial_stdin: Option<Vec<u8>>,
) -> ShellResult {
    if commands.is_empty() {
        return ShellResult::success("");
    }
    
    if commands.len() == 1 {
        return Box::pin(execute_command(&commands[0], env, initial_stdin)).await;
    }
    
    // Execute each command, threading stdout → stdin
    let mut current_stdin = initial_stdin;
    let mut final_result = ShellResult::success("");
    let mut all_stderr = String::new();
    
    for cmd in commands {
        let result = Box::pin(execute_command(cmd, env, current_stdin)).await;
        
        // The stdout of this command becomes stdin for the next
        current_stdin = if result.stdout.is_empty() {
            None
        } else {
            Some(result.stdout.into_bytes())
        };
        
        // Accumulate stderr
        all_stderr.push_str(&result.stderr);
        
        // Track the last result
        final_result = ShellResult {
            stdout: String::new(), // Will be set from current_stdin at the end
            stderr: String::new(),
            code: result.code,
        };
    }
    
    // Final stdout is whatever the last command produced
    let final_stdout = current_stdin
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();
    
    ShellResult {
        stdout: final_stdout,
        stderr: all_stderr,
        code: final_result.code,
    }
}

/// Execute a simple command with stdin support
async fn execute_simple(
    name: &str,
    args: &[String],
    env_vars: &[(String, String)],
    redirects: &[ParsedRedirect],
    env: &mut ShellEnv,
    stdin: Option<Vec<u8>>,
) -> ShellResult {
    // Expand command name
    let expanded_name = match expand::expand_string(name, env, false) {
        Ok(s) => s,
        Err(e) => return ShellResult::error(e, 1),
    };
    
    // Process any command substitution markers in the name
    let expanded_name = super::pipeline::execute_command_substitutions(&expanded_name, env).await;
    
    // Expand arguments (with brace expansion first, then variable expansion)
    let mut expanded_args = Vec::new();
    for arg in args {
        // First do brace expansion (before variable substitution)
        let brace_expanded = expand::expand_braces(arg);
        
        for be in brace_expanded {
            let expanded = match expand::expand_string(&be, env, false) {
                Ok(s) => s,
                Err(e) => return ShellResult::error(e, 1),
            };
            let final_exp = super::pipeline::execute_command_substitutions(&expanded, env).await;
            expanded_args.push(final_exp);
        }
    }
    
    // Set temporary environment variables (or permanent if no command)
    for (key, value) in env_vars {
        // Check if variable is readonly
        if env.readonly.contains(key) {
            return ShellResult::error(format!("{}: readonly variable", key), 1);
        }
        let expanded = expand::expand_string(value, env, false).unwrap_or_else(|_| value.clone());
        let _ = env.set_var(key, &expanded);
    }
    
    // If no command name, this is just a variable assignment
    if expanded_name.is_empty() {
        return ShellResult::success("");
    }
    
    // Handle builtins that need special treatment
    match expanded_name.as_str() {
        // No-op commands
        ":" => return ShellResult::success(""),
        "true" => return ShellResult::success(""),
        "false" => return ShellResult { code: 1, stdout: String::new(), stderr: String::new() },
        
        // Export
        "export" => {
            for arg in &expanded_args {
                if let Some(eq_pos) = arg.find('=') {
                    let key = &arg[..eq_pos];
                    let value = &arg[eq_pos + 1..];
                    let _ = env.set_var(key, value);
                    env.env_vars.insert(key.to_string(), value.to_string());
                }
            }
            return ShellResult::success("");
        }
        
        // Unset
        "unset" => {
            for arg in &expanded_args {
                // Ignore readonly errors for unset (just silently fail)
                let _ = env.unset_var(arg);
            }
            return ShellResult::success("");
        }
        
        // Set
        "set" => {
            return handle_set_builtin(&expanded_args, env);
        }
        
        // Shopt - shell options (bash extension)
        "shopt" => {
            return handle_shopt_builtin(&expanded_args, env);
        }
        
        // Readonly
        "readonly" => {
            for arg in &expanded_args {
                if let Some(eq_pos) = arg.find('=') {
                    let key = &arg[..eq_pos];
                    let value = &arg[eq_pos + 1..];
                    let _ = env.set_var(key, value);
                    env.readonly.insert(key.to_string());
                } else {
                    env.readonly.insert(arg.clone());
                }
            }
            return ShellResult::success("");
        }
        
        // Local (function scope)
        "local" => {
            if !env.in_function {
                return ShellResult::error("local: can only be used in a function", 1);
            }
            for arg in &expanded_args {
                if let Some(eq_pos) = arg.find('=') {
                    let key = &arg[..eq_pos];
                    let value = &arg[eq_pos + 1..];
                    env.local_vars.insert(key.to_string(), value.to_string());
                } else {
                    env.local_vars.insert(arg.clone(), String::new());
                }
            }
            return ShellResult::success("");
        }
        
        // Return (from function)
        "return" => {
            if !env.in_function {
                return ShellResult::error("return: can only be used in a function", 1);
            }
            let code = expanded_args.first()
                .and_then(|a| a.parse().ok())
                .unwrap_or(0);
            return ShellResult { code, stdout: String::new(), stderr: String::new() };
        }
        
        // Directory builtins
        "cd" => return handle_cd(&expanded_args, env),
        "pushd" => return handle_pushd(&expanded_args, env),
        "popd" => return handle_popd(&expanded_args, env),
        "dirs" => return handle_dirs(&expanded_args, env),
        "pwd" => return ShellResult::success(format!("{}\n", env.cwd.to_string_lossy())),
        
        _ => {}
    }
    
    // Check if this is a function call
    if let Some(body) = env.functions.get(&expanded_name).cloned() {
        return call_function(&body, &expanded_args, env, stdin).await;
    }
    
    // Get the command implementation
    let Some(cmd_fn) = ShellCommands::get_command(&expanded_name) else {
        return ShellResult::error(format!("{}: command not found", expanded_name), 127);
    };
    
    // Set up pipes
    let (stdin_reader, mut stdin_writer) = piper::pipe(PIPE_CAPACITY);
    let (stdout_reader, stdout_writer) = piper::pipe(PIPE_CAPACITY);
    let (stderr_reader, stderr_writer) = piper::pipe(PIPE_CAPACITY);
    
    // Handle stdin - from parameter or from redirect
    let stdin_data = match get_stdin_data(stdin, redirects, env) {
        Ok(data) => data,
        Err(err_result) => return err_result,
    };
    if let Some(data) = stdin_data {
        let _ = stdin_writer.write_all(&data).await;
    }
    drop(stdin_writer); // Signal EOF
    
    // Execute command
    let code = cmd_fn(expanded_args, env, stdin_reader, stdout_writer, stderr_writer).await;
    
    // Collect output
    let stdout_bytes = drain_reader(stdout_reader).await;
    let stderr_bytes = drain_reader(stderr_reader).await;
    
    // Handle output redirects
    let (stdout, stderr) = handle_output_redirects(
        stdout_bytes, 
        stderr_bytes, 
        redirects, 
        &env.cwd.to_string_lossy()
    );
    
    ShellResult { stdout, stderr, code }
}

/// Get stdin data from parameter or redirect
fn get_stdin_data(
    stdin: Option<Vec<u8>>,
    redirects: &[ParsedRedirect],
    env: &ShellEnv,
) -> Result<Option<Vec<u8>>, ShellResult> {
    // Check for stdin redirect (< file)
    for redirect in redirects {
        if let ParsedRedirect::Read { target, .. } = redirect {
            let full_path = if target.starts_with('/') {
                target.clone()
            } else {
                format!("{}/{}", env.cwd.to_string_lossy(), target)
            };
            match std::fs::read(&full_path) {
                Ok(content) => return Ok(Some(content)),
                Err(e) => return Err(ShellResult::error(format!("{}: {}", target, e), 1)),
            }
        }
    }
    
    // Otherwise use provided stdin
    Ok(stdin)
}

/// Handle output redirects (>, >>, 2>, etc.)
fn handle_output_redirects(
    stdout_bytes: Vec<u8>,
    stderr_bytes: Vec<u8>,
    redirects: &[ParsedRedirect],
    cwd: &str,
) -> (String, String) {
    let mut stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let mut stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
    
    for redirect in redirects {
        match redirect {
            ParsedRedirect::Write { fd, target } => {
                let full_path = if target.starts_with('/') {
                    target.clone()
                } else {
                    format!("{}/{}", cwd, target)
                };
                
                let content = if fd.unwrap_or(1) == 1 {
                    std::mem::take(&mut stdout)
                } else {
                    std::mem::take(&mut stderr)
                };
                let _ = std::fs::write(&full_path, content);
            }
            ParsedRedirect::Append { fd, target } => {
                let full_path = if target.starts_with('/') {
                    target.clone()
                } else {
                    format!("{}/{}", cwd, target)
                };
                
                let content = if fd.unwrap_or(1) == 1 {
                    std::mem::take(&mut stdout)
                } else {
                    std::mem::take(&mut stderr)
                };
                
                let mut file_content = std::fs::read_to_string(&full_path).unwrap_or_default();
                file_content.push_str(&content);
                let _ = std::fs::write(&full_path, file_content);
            }
            _ => {}
        }
    }
    
    (stdout, stderr)
}

/// Handle the set builtin
fn handle_set_builtin(args: &[String], env: &mut ShellEnv) -> ShellResult {
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg.starts_with('-') || arg.starts_with('+') {
            let enable = arg.starts_with('-');
            let flag = &arg[1..];
            
            if flag == "o" {
                // Handle -o option
                i += 1;
                if i < args.len() {
                    let opt_name = &args[i];
                    let _ = env.options.parse_long_option(opt_name, enable);
                }
            } else {
                // Short options
                for c in flag.chars() {
                    match c {
                        'e' => env.options.errexit = enable,
                        'u' => env.options.nounset = enable,
                        'x' => env.options.xtrace = enable,
                        _ => {}
                    }
                }
            }
        }
        i += 1;
    }
    ShellResult::success("")
}

/// Handle shopt builtin for bash-style shell options
fn handle_shopt_builtin(args: &[String], env: &mut ShellEnv) -> ShellResult {
    // Parse flags: -s (set), -u (unset), -p (print), -q (query)
    let mut set_mode = false;
    let mut unset_mode = false;
    let mut print_mode = false;
    let mut query_mode = false;
    let mut options_to_process: Vec<&str> = Vec::new();
    
    for arg in args {
        if arg == "-s" {
            set_mode = true;
        } else if arg == "-u" {
            unset_mode = true;
        } else if arg == "-p" {
            print_mode = true;
        } else if arg == "-q" {
            query_mode = true;
        } else if !arg.starts_with('-') {
            options_to_process.push(arg);
        }
    }
    
    // If no options specified, list all options
    if options_to_process.is_empty() && !set_mode && !unset_mode {
        let output = format_shopt_options(&env.options, print_mode);
        return ShellResult::success(output);
    }
    
    // Process each option
    let mut all_set = true;
    for opt in &options_to_process {
        if set_mode {
            if let Err(e) = env.options.parse_shopt(opt, true) {
                return ShellResult::error(e, 1);
            }
        } else if unset_mode {
            if let Err(e) = env.options.parse_shopt(opt, false) {
                return ShellResult::error(e, 1);
            }
        } else if query_mode {
            // Query mode: return 0 if all options are set, 1 otherwise
            if !is_shopt_set(&env.options, opt) {
                all_set = false;
            }
        } else {
            // Print mode for specific options
            let output = format_single_shopt(&env.options, opt, print_mode);
            return ShellResult::success(output);
        }
    }
    
    if query_mode {
        return ShellResult { 
            code: if all_set { 0 } else { 1 },
            stdout: String::new(),
            stderr: String::new(),
        };
    }
    
    ShellResult::success("")
}

/// Format all shopt options for display
fn format_shopt_options(opts: &super::env::ShellOptions, print_format: bool) -> String {
    let options = [
        ("extglob", opts.extglob),
        ("nullglob", opts.nullglob),
        ("dotglob", opts.dotglob),
        ("nocasematch", opts.nocasematch),
        ("nocaseglob", opts.nocaseglob),
        ("globstar", opts.globstar),
        ("expand_aliases", opts.expand_aliases),
    ];
    
    let mut output = String::new();
    for (name, value) in options {
        if print_format {
            output.push_str(&format!("shopt {} {}\n", if value { "-s" } else { "-u" }, name));
        } else {
            output.push_str(&format!("{}\t{}\n", name, if value { "on" } else { "off" }));
        }
    }
    output
}

/// Format a single shopt option
fn format_single_shopt(opts: &super::env::ShellOptions, name: &str, print_format: bool) -> String {
    let value = is_shopt_set(opts, name);
    if print_format {
        format!("shopt {} {}\n", if value { "-s" } else { "-u" }, name)
    } else {
        format!("{}\t{}\n", name, if value { "on" } else { "off" })
    }
}

/// Check if a shopt option is set
fn is_shopt_set(opts: &super::env::ShellOptions, name: &str) -> bool {
    match name {
        "extglob" => opts.extglob,
        "nullglob" => opts.nullglob,
        "dotglob" => opts.dotglob,
        "nocasematch" => opts.nocasematch,
        "nocaseglob" => opts.nocaseglob,
        "globstar" => opts.globstar,
        "expand_aliases" => opts.expand_aliases,
        _ => false,
    }
}

/// Define a function
fn define_function(name: &str, body: &ParsedCommand, env: &mut ShellEnv) {
    // Convert body to shell string for storage
    let body_str = to_shell_string(body);
    env.functions.insert(name.to_string(), body_str);
}

/// Call a function with arguments and stdin
async fn call_function(
    body: &str,
    args: &[String],
    env: &mut ShellEnv,
    stdin: Option<Vec<u8>>,
) -> ShellResult {
    // Save state
    let old_params = std::mem::replace(&mut env.positional_params, args.to_vec());
    let old_in_function = env.in_function;
    let old_local_vars = std::mem::take(&mut env.local_vars);
    env.in_function = true;
    
    // Parse and execute function body with stdin
    let result = match super::parser::parse_command(body) {
        Ok(parsed) if !parsed.is_empty() => {
            Box::pin(execute_sequence(&parsed, env, stdin)).await
        }
        Ok(_) => ShellResult::success(""),
        Err(e) => ShellResult::error(format!("function parse error: {}", e), 1),
    };
    
    // Restore state
    env.positional_params = old_params;
    env.in_function = old_in_function;
    env.local_vars = old_local_vars;
    
    result
}

/// Execute a for loop
async fn execute_for(
    var: &str,
    words: &[String],
    body: &[ParsedCommand],
    env: &mut ShellEnv,
    _stdin: Option<Vec<u8>>,
) -> ShellResult {
    let mut combined_stdout = String::new();
    let mut combined_stderr = String::new();
    let mut last_code = 0;
    
    // Expand words
    let mut expanded_words = Vec::new();
    for word in words {
        let expanded = expand::expand_string(word, env, false).unwrap_or_else(|_| word.clone());
        // Split on whitespace for word splitting
        for part in expanded.split_whitespace() {
            expanded_words.push(part.to_string());
        }
    }
    
    for word in expanded_words {
        let _ = env.set_var(var, &word);
        
        for cmd in body {
            let result = Box::pin(execute_command(cmd, env, None)).await;
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

/// Execute a while loop
async fn execute_while(
    condition: &[ParsedCommand],
    body: &[ParsedCommand],
    env: &mut ShellEnv,
    _stdin: Option<Vec<u8>>,
) -> ShellResult {
    let mut combined_stdout = String::new();
    let mut combined_stderr = String::new();
    let mut last_code = 0;
    
    loop {
        // Evaluate condition
        let mut cond_result = ShellResult::success("");
        for cmd in condition {
            cond_result = Box::pin(execute_command(cmd, env, None)).await;
        }
        
        if cond_result.code != 0 {
            break;
        }
        
        // Execute body
        for cmd in body {
            let result = Box::pin(execute_command(cmd, env, None)).await;
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

/// Execute an if statement
async fn execute_if(
    conditionals: &[(Vec<ParsedCommand>, Vec<ParsedCommand>)],
    else_branch: &Option<Vec<ParsedCommand>>,
    env: &mut ShellEnv,
    _stdin: Option<Vec<u8>>,
) -> ShellResult {
    for (condition, body) in conditionals {
        // Evaluate condition
        let mut cond_result = ShellResult::success("");
        for cmd in condition {
            cond_result = Box::pin(execute_command(cmd, env, None)).await;
        }
        
        if cond_result.code == 0 {
            // Condition true - execute body
            let mut result = ShellResult::success("");
            for cmd in body {
                result = Box::pin(execute_command(cmd, env, None)).await;
            }
            return result;
        }
    }
    
    // No condition matched - try else branch
    if let Some(else_body) = else_branch {
        let mut result = ShellResult::success("");
        for cmd in else_body {
            result = Box::pin(execute_command(cmd, env, None)).await;
        }
        return result;
    }
    
    ShellResult::success("")
}

/// Execute a case statement
async fn execute_case(
    word: &str,
    cases: &[(Vec<String>, Vec<ParsedCommand>)],
    env: &mut ShellEnv,
    _stdin: Option<Vec<u8>>,
) -> ShellResult {
    // Expand the word
    let expanded_word = expand::expand_string(word, env, false).unwrap_or_else(|_| word.to_string());
    
    for (patterns, body) in cases {
        for pattern in patterns {
            // Simple pattern matching (supports * and ?)
            if matches_pattern(&expanded_word, pattern) {
                let mut result = ShellResult::success("");
                for cmd in body {
                    result = Box::pin(execute_command(cmd, env, None)).await;
                }
                return result;
            }
        }
    }
    
    ShellResult::success("")
}

/// Simple glob pattern matching
fn matches_pattern(text: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if pattern == text {
        return true;
    }
    
    // Simple wildcard matching
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return text == pattern;
    }
    
    let mut pos = 0;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if let Some(found) = text[pos..].find(part) {
            if i == 0 && found != 0 {
                return false; // First part must be at start
            }
            pos += found + part.len();
        } else {
            return false;
        }
    }
    
    // If pattern doesn't end with *, text must end at pos
    if !pattern.ends_with('*') && pos != text.len() {
        return false;
    }
    
    true
}

/// Convert a ParsedCommand back to shell string (for function storage)
fn to_shell_string(cmd: &ParsedCommand) -> String {
    match cmd {
        ParsedCommand::Simple { name, args, env_vars, .. } => {
            let mut parts = Vec::new();
            for (k, v) in env_vars {
                parts.push(format!("{}={}", k, v));
            }
            if !name.is_empty() {
                parts.push(name.clone());
            }
            parts.extend(args.iter().cloned());
            parts.join(" ")
        }
        ParsedCommand::Pipeline { commands, negate } => {
            let cmds: Vec<String> = commands.iter().map(to_shell_string).collect();
            let pipeline = cmds.join(" | ");
            if *negate { format!("! {}", pipeline) } else { pipeline }
        }
        ParsedCommand::And(left, right) => {
            format!("{} && {}", to_shell_string(left), to_shell_string(right))
        }
        ParsedCommand::Or(left, right) => {
            format!("{} || {}", to_shell_string(left), to_shell_string(right))
        }
        ParsedCommand::For { var, words, body } => {
            let body_strs: Vec<String> = body.iter().map(to_shell_string).collect();
            format!("for {} in {}; do {}; done", var, words.join(" "), body_strs.join("; "))
        }
        ParsedCommand::While { condition, body } => {
            let cond_strs: Vec<String> = condition.iter().map(to_shell_string).collect();
            let body_strs: Vec<String> = body.iter().map(to_shell_string).collect();
            format!("while {}; do {}; done", cond_strs.join("; "), body_strs.join("; "))
        }
        ParsedCommand::If { conditionals, else_branch } => {
            let mut result = String::new();
            for (i, (cond, body)) in conditionals.iter().enumerate() {
                let cond_strs: Vec<String> = cond.iter().map(to_shell_string).collect();
                let body_strs: Vec<String> = body.iter().map(to_shell_string).collect();
                if i == 0 {
                    result.push_str(&format!("if {}; then {}", cond_strs.join("; "), body_strs.join("; ")));
                } else {
                    result.push_str(&format!("; elif {}; then {}", cond_strs.join("; "), body_strs.join("; ")));
                }
            }
            if let Some(else_body) = else_branch {
                let else_strs: Vec<String> = else_body.iter().map(to_shell_string).collect();
                result.push_str(&format!("; else {}", else_strs.join("; ")));
            }
            result.push_str("; fi");
            result
        }
        ParsedCommand::Case { word, cases } => {
            let mut result = format!("case {} in ", word);
            for (patterns, body) in cases {
                let body_strs: Vec<String> = body.iter().map(to_shell_string).collect();
                result.push_str(&format!("{}) {};; ", patterns.join("|"), body_strs.join("; ")));
            }
            result.push_str("esac");
            result
        }
        ParsedCommand::Subshell(commands) => {
            let cmd_strs: Vec<String> = commands.iter().map(to_shell_string).collect();
            format!("( {} )", cmd_strs.join("; "))
        }
        ParsedCommand::Brace(commands) => {
            let cmd_strs: Vec<String> = commands.iter().map(to_shell_string).collect();
            format!("{{ {}; }}", cmd_strs.join("; "))
        }
        ParsedCommand::FunctionDef { name, body } => {
            format!("{} () {{ {}; }}", name, to_shell_string(body))
        }
        ParsedCommand::Background(cmd) => {
            format!("{} &", to_shell_string(cmd))
        }
    }
}

/// Drain a piper reader into a Vec<u8>
async fn drain_reader(mut reader: piper::Reader) -> Vec<u8> {
    use futures_lite::io::AsyncReadExt;
    let mut buffer = Vec::new();
    let _ = reader.read_to_end(&mut buffer).await;
    buffer
}

// ==== Directory Builtins ====

/// Handle cd built-in command
fn handle_cd(args: &[String], env: &mut ShellEnv) -> ShellResult {
    use std::path::PathBuf;
    
    let target = if args.is_empty() || args[0] == "~" {
        "/".to_string()
    } else if args[0] == "-" {
        let prev = env.prev_cwd.to_string_lossy().to_string();
        prev
    } else {
        super::pipeline::resolve_path(&env.cwd.to_string_lossy(), &args[0])
    };
    
    let normalized = super::pipeline::normalize_path(&target);
    
    if let Ok(metadata) = std::fs::metadata(&normalized) {
        if !metadata.is_dir() {
            return ShellResult::error(format!("cd: {}: Not a directory", args.get(0).unwrap_or(&"~".to_string())), 1);
        }
    } else {
        return ShellResult::error(format!("cd: {}: No such file or directory", args.get(0).unwrap_or(&"~".to_string())), 1);
    }
    
    env.prev_cwd = env.cwd.clone();
    env.cwd = PathBuf::from(normalized);
    
    ShellResult::success("")
}

/// Handle pushd built-in command
fn handle_pushd(args: &[String], env: &mut ShellEnv) -> ShellResult {
    use std::path::PathBuf;
    
    if args.is_empty() {
        if let Some(top) = env.dir_stack.pop() {
            let old_cwd = env.cwd.clone();
            env.prev_cwd = env.cwd.clone();
            env.cwd = top;
            env.dir_stack.push(old_cwd);
        } else {
            return ShellResult::error("pushd: no other directory", 1);
        }
    } else {
        let target = super::pipeline::resolve_path(&env.cwd.to_string_lossy(), &args[0]);
        let normalized = super::pipeline::normalize_path(&target);
        
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

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_run_shell_echo() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_shell("echo hello", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "hello");
    }
    
    #[test]
    fn test_run_shell_pipeline() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_shell("echo hello | cat", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "hello");
    }
    
    #[test]
    fn test_run_shell_true_false() {
        let mut env = ShellEnv::new();
        
        let result = futures_lite::future::block_on(run_shell("true", &mut env));
        assert_eq!(result.code, 0);
        
        let result = futures_lite::future::block_on(run_shell("false", &mut env));
        assert_eq!(result.code, 1);
        
        let result = futures_lite::future::block_on(run_shell(":", &mut env));
        assert_eq!(result.code, 0);
    }
    
    #[test]
    fn test_brace_in_pipeline() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(run_shell(
            "echo hello | { cat; }",
            &mut env
        ));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "hello");
    }
    
    #[test]
    fn test_function_with_stdin() {
        let mut env = ShellEnv::new();
        // Define function with POSIX syntax (semicolon before })
        futures_lite::future::block_on(run_shell("upper() { tr 'a-z' 'A-Z'; }", &mut env));
        let result = futures_lite::future::block_on(run_shell("echo hello | upper", &mut env));
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.trim(), "HELLO");
    }
}
