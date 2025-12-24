//! AST Executor - executes ParsedCommand AST nodes from brush-parser.
//!
//! This module bridges the brush-parser AST to the existing pipeline execution logic.

use super::env::{ShellEnv, ShellResult};
use super::expand;
use super::parser::{ParsedCommand, ParsedRedirect};

/// Execute a parsed command AST
pub async fn execute_parsed(cmd: &ParsedCommand, env: &mut ShellEnv) -> ShellResult {
    match cmd {
        ParsedCommand::Simple { name, args, redirects, env_vars } => {
            execute_simple(name, args, redirects, env_vars, env).await
        }
        ParsedCommand::Pipeline { commands, negate } => {
            execute_pipeline(commands, *negate, env).await
        }
        ParsedCommand::And(left, right) => {
            let left_result = Box::pin(execute_parsed(left, env)).await;
            if left_result.code == 0 {
                let right_result = Box::pin(execute_parsed(right, env)).await;
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
            let left_result = Box::pin(execute_parsed(left, env)).await;
            if left_result.code != 0 {
                let right_result = Box::pin(execute_parsed(right, env)).await;
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
            execute_for(var, words, body, env).await
        }
        ParsedCommand::While { condition, body } => {
            execute_while(condition, body, env).await
        }
        ParsedCommand::If { conditionals, else_branch } => {
            execute_if(conditionals, else_branch.as_ref(), env).await
        }
        ParsedCommand::Case { word, cases } => {
            execute_case(word, cases, env).await
        }
        ParsedCommand::Subshell(commands) => {
            execute_subshell(commands, env).await
        }
        ParsedCommand::Brace(commands) => {
            execute_brace(commands, env).await
        }
        ParsedCommand::FunctionDef { name, body } => {
            execute_function_def(name, body, env)
        }
        ParsedCommand::Background(cmd) => {
            // For now, just execute synchronously (WASI doesn't have true background)
            Box::pin(execute_parsed(cmd, env)).await
        }
    }
}

/// Execute a sequence of parsed commands
pub async fn execute_sequence(commands: &[ParsedCommand], env: &mut ShellEnv) -> ShellResult {
    let mut combined_stdout = String::new();
    let mut combined_stderr = String::new();
    let mut last_code = 0;
    
    for cmd in commands {
        let result = Box::pin(execute_parsed(cmd, env)).await;
        combined_stdout.push_str(&result.stdout);
        combined_stderr.push_str(&result.stderr);
        last_code = result.code;
        env.last_exit_code = last_code;
    }
    
    ShellResult {
        stdout: combined_stdout,
        stderr: combined_stderr,
        code: last_code,
    }
}

/// Execute a simple command
async fn execute_simple(
    name: &str,
    args: &[String],
    _redirects: &[ParsedRedirect],
    env_vars: &[(String, String)],
    env: &mut ShellEnv,
) -> ShellResult {
    // Handle empty command (just env vars)
    if name.is_empty() {
        for (key, value) in env_vars {
            let expanded = expand::expand_string(value, env, false).unwrap_or_else(|_| value.clone());
            if let Err(e) = env.set_var(key, &expanded) {
                return ShellResult::error(e, 1);
            }
        }
        return ShellResult::success("");
    }
    
    // Expand command name and args
    let expanded_name_raw = expand::expand_string(name, env, false).unwrap_or_else(|_| name.to_string());
    let expanded_name = super::pipeline::execute_command_substitutions(&expanded_name_raw, env).await;
    
    let mut expanded_args = Vec::new();
    for a in args {
        let exp = expand::expand_string(a, env, false).unwrap_or_else(|_| a.clone());
        let final_exp = super::pipeline::execute_command_substitutions(&exp, env).await;
        expanded_args.push(final_exp);
    }
    
    // Set temporary environment variables
    for (key, value) in env_vars {
        let expanded = expand::expand_string(value, env, false).unwrap_or_else(|_| value.clone());
        let _ = env.set_var(key, &expanded);
    }
    
    // Handle shell builtins directly to avoid recursive parsing
    match expanded_name.as_str() {
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
        "unset" => {
            for arg in &expanded_args {
                let _ = env.unset_var(arg);
            }
            return ShellResult::success("");
        }
        "set" => {
            // Handle set -e, set -x, set -o pipefail, etc.
            let mut i = 0;
            while i < expanded_args.len() {
                let arg = &expanded_args[i];
                if arg.starts_with('-') || arg.starts_with('+') {
                    let enable = arg.starts_with('-');
                    let flag = &arg[1..];
                    
                    if flag == "o" {
                        // -o long_option - next arg is the option name
                        i += 1;
                        if i < expanded_args.len() {
                            let opt_name = &expanded_args[i];
                            let _ = env.options.parse_long_option(opt_name, enable);
                        }
                    } else {
                        // Short options like -e, -x, -u
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
            return ShellResult::success("");
        }
        "readonly" => {
            for arg in &expanded_args {
                if let Some(eq_pos) = arg.find('=') {
                    let key = &arg[..eq_pos];
                    let value = &arg[eq_pos + 1..];
                    let _ = env.set_readonly(key, Some(value));
                } else {
                    let _ = env.set_readonly(arg, None);
                }
            }
            return ShellResult::success("");
        }
        "local" => {
            // local can only be used inside a function
            if !env.in_function {
                return ShellResult::error("local: can only be used in a function", 1);
            }
            // Set local variables
            for arg in &expanded_args {
                if let Some(eq_pos) = arg.find('=') {
                    let key = &arg[..eq_pos];
                    let value = &arg[eq_pos + 1..];
                    env.local_vars.insert(key.to_string(), value.to_string());
                }
            }
            return ShellResult::success("");
        }
        "return" => {
            // return can only be used inside a function
            if !env.in_function {
                return ShellResult::error("return: can only be used in a function", 1);
            }
            // Return from function with the given exit code
            let code = expanded_args.first()
                .and_then(|a| a.parse().ok())
                .unwrap_or(0);
            return ShellResult {
                stdout: String::new(),
                stderr: String::new(),
                code,
            };
        }
        _ => {}
    }
    
    // Check if this is a function call - if so, delegate to run_single_pipeline
    // which has proper function execution handling
    if env.functions.contains_key(&expanded_name) {

        let mut cmd_line = expanded_name.clone();
        for arg in &expanded_args {
            cmd_line.push(' ');
            cmd_line.push_str(arg);
        }
        return super::pipeline::run_single_pipeline(&cmd_line, env).await;
    }
    
    // Don't re-quote - brush-parser Word already includes proper quoting in its output
    let mut cmd_line = expanded_name.clone();
    for arg in &expanded_args {
        cmd_line.push(' ');
        cmd_line.push_str(arg);
    }
    
    // Use existing pipeline execution for the actual command
    super::pipeline::run_single_pipeline(&cmd_line, env).await
}

/// Execute a pipeline of commands
async fn execute_pipeline(
    commands: &[ParsedCommand],
    negate: bool,
    env: &mut ShellEnv,
) -> ShellResult {
    if commands.is_empty() {
        return ShellResult::success("");
    }
    
    if commands.len() == 1 {
        let result = Box::pin(execute_parsed(&commands[0], env)).await;
        if negate {
            return ShellResult {
                code: if result.code == 0 { 1 } else { 0 },
                ..result
            };
        }
        return result;
    }
    
    // For multi-command pipelines, we need to handle both Simple and control flow commands
    // Strategy: Execute the first command (which may be control flow), capture its output,
    // then pipe it through the remaining commands
    
    let first = &commands[0];
    let rest = &commands[1..];
    
    // Execute the first command to get its output
    let first_result = Box::pin(execute_parsed(first, env)).await;
    
    if rest.is_empty() {
        if negate {
            return ShellResult {
                code: if first_result.code == 0 { 1 } else { 0 },
                ..first_result
            };
        }
        return first_result;
    }
    
    // Build the remaining pipeline as Simple commands only
    let mut rest_parts = Vec::new();
    for cmd in rest {
        if let ParsedCommand::Simple { name, args, .. } = cmd {
            let mut part = name.clone();
            for arg in args {
                part.push(' ');
                part.push_str(arg);
            }
            rest_parts.push(part);
        }
    }
    
    if rest_parts.is_empty() {
        if negate {
            return ShellResult {
                code: if first_result.code == 0 { 1 } else { 0 },
                ..first_result
            };
        }
        return first_result;
    }
    
    // Pipe the first command's output through the rest of the pipeline
    // Use printf to feed the output through
    let escaped_output = first_result.stdout.replace('\\', "\\\\").replace('\'', "'\\''");
    let piped_cmd = format!("printf '%s' '{}' | {}", escaped_output, rest_parts.join(" | "));
    
    let result = super::pipeline::run_single_pipeline(&piped_cmd, env).await;
    
    if negate {
        ShellResult {
            code: if result.code == 0 { 1 } else { 0 },
            ..result
        }
    } else {
        result
    }
}

/// Execute a for loop
async fn execute_for(
    var: &str,
    words: &[String],
    body: &[ParsedCommand],
    env: &mut ShellEnv,
) -> ShellResult {
    let mut combined_stdout = String::new();
    let mut combined_stderr = String::new();
    let mut last_code = 0;
    
    // Expand words
    let expanded_words: Vec<String> = words.iter()
        .map(|w| expand::expand_string(w, env, false).unwrap_or_else(|_| w.clone()))
        .collect();
    
    for word in &expanded_words {
        let _ = env.set_var(var, word);
        let result = execute_sequence(body, env).await;
        combined_stdout.push_str(&result.stdout);
        combined_stderr.push_str(&result.stderr);
        last_code = result.code;
        
        // Handle break/continue (simplified - just check exit code for now)
        if result.code != 0 && env.options.errexit {
            break;
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
) -> ShellResult {
    let mut combined_stdout = String::new();
    let mut combined_stderr = String::new();
    let mut last_code = 0;
    let mut iterations = 0;
    const MAX_ITERATIONS: usize = 10000;
    
    loop {
        // Check condition
        let cond_result = execute_sequence(condition, env).await;
        if cond_result.code != 0 {
            break;
        }
        
        // Execute body
        let body_result = execute_sequence(body, env).await;
        combined_stdout.push_str(&body_result.stdout);
        combined_stderr.push_str(&body_result.stderr);
        last_code = body_result.code;
        
        iterations += 1;
        if iterations >= MAX_ITERATIONS {
            return ShellResult::error("while loop exceeded maximum iterations", 1);
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
    else_branch: Option<&Vec<ParsedCommand>>,
    env: &mut ShellEnv,
) -> ShellResult {
    for (condition, then_body) in conditionals {
        let cond_result = execute_sequence(condition, env).await;
        if cond_result.code == 0 {
            return execute_sequence(then_body, env).await;
        }
    }
    
    // No condition matched, run else branch if present
    if let Some(else_body) = else_branch {
        execute_sequence(else_body, env).await
    } else {
        ShellResult::success("")
    }
}

/// Execute a case statement
async fn execute_case(
    word: &str,
    cases: &[(Vec<String>, Vec<ParsedCommand>)],
    env: &mut ShellEnv,
) -> ShellResult {
    let expanded_word = expand::expand_string(word, env, false).unwrap_or_else(|_| word.to_string());
    
    for (patterns, body) in cases {
        for pattern in patterns {
            let expanded_pattern = expand::expand_string(pattern, env, false).unwrap_or_else(|_| pattern.clone());
            if pattern_matches(&expanded_word, &expanded_pattern) {
                return execute_sequence(body, env).await;
            }
        }
    }
    
    ShellResult::success("")
}

/// Simple pattern matching for case statements
fn pattern_matches(text: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    // Simple exact match for now
    text == pattern
}

/// Execute a subshell
async fn execute_subshell(
    commands: &[ParsedCommand],
    env: &mut ShellEnv,
) -> ShellResult {
    let mut sub_env = env.subshell();
    execute_sequence(commands, &mut sub_env).await
}

/// Execute a brace group
async fn execute_brace(
    commands: &[ParsedCommand],
    env: &mut ShellEnv,
) -> ShellResult {
    execute_sequence(commands, env).await
}

/// Define a function
fn execute_function_def(
    name: &str,
    body: &ParsedCommand,
    env: &mut ShellEnv,
) -> ShellResult {
    // Convert the ParsedCommand back to shell command string
    let body_str = to_shell_string(body);

    env.functions.insert(name.to_string(), body_str);
    ShellResult::success("")
}

/// Convert a ParsedCommand back to shell command string
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
            if *negate {
                format!("! {}", pipeline)
            } else {
                pipeline
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execute_simple() {
        let mut env = ShellEnv::new();
        let result = futures_lite::future::block_on(execute_parsed(
            &ParsedCommand::Simple {
                name: "echo".to_string(),
                args: vec!["hello".to_string()],
                redirects: vec![],
                env_vars: vec![],
            },
            &mut env,
        ));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("hello"));
    }

    #[test]
    fn test_execute_and_chain() {
        let mut env = ShellEnv::new();
        let cmd = ParsedCommand::And(
            Box::new(ParsedCommand::Simple {
                name: "true".to_string(),
                args: vec![],
                redirects: vec![],
                env_vars: vec![],
            }),
            Box::new(ParsedCommand::Simple {
                name: "echo".to_string(),
                args: vec!["success".to_string()],
                redirects: vec![],
                env_vars: vec![],
            }),
        );
        let result = futures_lite::future::block_on(execute_parsed(&cmd, &mut env));
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("success"));
    }

    #[test]
    fn test_execute_for_loop() {
        let mut env = ShellEnv::new();
        let cmd = ParsedCommand::For {
            var: "x".to_string(),
            words: vec!["a".to_string(), "b".to_string(), "c".to_string()],
            body: vec![ParsedCommand::Simple {
                name: "echo".to_string(),
                args: vec!["$x".to_string()],
                redirects: vec![],
                env_vars: vec![],
            }],
        };
        let result = futures_lite::future::block_on(execute_parsed(&cmd, &mut env));
        assert_eq!(result.code, 0);
        // Each iteration should produce output
        assert!(!result.stdout.is_empty(), "stdout was empty, stderr: {}", result.stderr);
    }
}
