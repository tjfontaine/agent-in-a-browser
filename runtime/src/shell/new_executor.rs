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
        },
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
        ParsedCommand::Simple {
            name,
            args,
            redirects,
            env_vars,
        } => execute_simple(name, args, env_vars, redirects, env, stdin).await,

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

        ParsedCommand::For { var, words, body } => execute_for(var, words, body, env, stdin).await,

        ParsedCommand::While { condition, body } => {
            execute_while(condition, body, env, stdin).await
        }

        ParsedCommand::If {
            conditionals,
            else_branch,
        } => execute_if(conditionals, else_branch, env, stdin).await,

        ParsedCommand::Case { word, cases } => execute_case(word, cases, env, stdin).await,

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

    // Expand arguments (with brace expansion first, then variable expansion, then glob)
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

            // Finally, do pathname/glob expansion
            let glob_results =
                expand::expand_glob(&final_exp, &env.cwd.to_string_lossy(), &env.options);
            expanded_args.extend(glob_results);
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
        "false" => {
            return ShellResult {
                code: 1,
                stdout: String::new(),
                stderr: String::new(),
            }
        }

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
            let code = expanded_args
                .first()
                .and_then(|a| a.parse().ok())
                .unwrap_or(0);
            return ShellResult {
                code,
                stdout: String::new(),
                stderr: String::new(),
            };
        }

        // Loop control builtins
        "break" => {
            if env.loop_depth == 0 {
                return ShellResult::error("break: only meaningful in a loop", 1);
            }
            // Parse optional level (default 1)
            let level: usize = expanded_args
                .first()
                .and_then(|a| a.parse().ok())
                .unwrap_or(1)
                .max(1); // At least 1
            env.break_level = level.min(env.loop_depth); // Cap at current depth
            return ShellResult::success("");
        }

        "continue" => {
            if env.loop_depth == 0 {
                return ShellResult::error("continue: only meaningful in a loop", 1);
            }
            // Parse optional level (default 1)
            let level: usize = expanded_args
                .first()
                .and_then(|a| a.parse().ok())
                .unwrap_or(1)
                .max(1); // At least 1
            env.continue_level = level.min(env.loop_depth); // Cap at current depth
            return ShellResult::success("");
        }

        // Directory builtins
        "cd" => return handle_cd(&expanded_args, env),
        "pushd" => return handle_pushd(&expanded_args, env),
        "popd" => return handle_popd(&expanded_args, env),
        "dirs" => return handle_dirs(&expanded_args, env),
        "pwd" => return ShellResult::success(format!("{}\n", env.cwd.to_string_lossy())),

        // eval - execute arguments as shell command
        "eval" => {
            if expanded_args.is_empty() {
                return ShellResult::success("");
            }
            // Join all arguments into a single command string
            let cmd_string = expanded_args.join(" ");
            // Parse and execute
            return match super::parser::parse_command(&cmd_string) {
                Ok(parsed) if !parsed.is_empty() => {
                    Box::pin(execute_sequence(&parsed, env, stdin)).await
                }
                Ok(_) => ShellResult::success(""),
                Err(e) => ShellResult::error(format!("eval: {}", e), 1),
            };
        }

        // alias - define or display aliases
        "alias" => {
            if expanded_args.is_empty() {
                // List all aliases
                let mut output = String::new();
                for (name, value) in &env.aliases {
                    output.push_str(&format!("alias {}='{}'\n", name, value));
                }
                return ShellResult::success(output);
            }

            for arg in &expanded_args {
                if let Some(eq_pos) = arg.find('=') {
                    // Define alias: alias name=value
                    let name = &arg[..eq_pos];
                    let value = &arg[eq_pos + 1..];
                    // Remove surrounding quotes if present
                    let value = value.trim_matches(|c| c == '\'' || c == '"');
                    env.aliases.insert(name.to_string(), value.to_string());
                } else {
                    // Display specific alias
                    if let Some(value) = env.aliases.get(arg) {
                        return ShellResult::success(format!("alias {}='{}'\n", arg, value));
                    } else {
                        return ShellResult::error(format!("alias: {}: not found", arg), 1);
                    }
                }
            }
            return ShellResult::success("");
        }

        // unalias - remove aliases
        "unalias" => {
            if expanded_args.is_empty() {
                return ShellResult::error("unalias: usage: unalias name [name ...]", 1);
            }

            for arg in &expanded_args {
                if arg == "-a" {
                    // Remove all aliases
                    env.aliases.clear();
                } else {
                    env.aliases.remove(arg);
                }
            }
            return ShellResult::success("");
        }

        // getopts - parse positional parameters
        "getopts" => {
            // getopts optstring name [args]
            // Sets name to the option found, OPTARG to its argument
            // Returns 0 if option found, 1 if end of options
            if expanded_args.len() < 2 {
                return ShellResult::error("getopts: usage: getopts optstring name [args]", 1);
            }

            let optstring = &expanded_args[0];
            let name = &expanded_args[1];

            // Get args to parse (either from args or positional params)
            let args_to_parse: Vec<String> = if expanded_args.len() > 2 {
                expanded_args[2..].to_vec()
            } else {
                env.positional_params.clone()
            };

            // Get current OPTIND (1-based index)
            let optind: usize = env
                .get_var("OPTIND")
                .and_then(|s| s.parse().ok())
                .unwrap_or(1);

            // Check if we've exhausted arguments
            if optind > args_to_parse.len() {
                let _ = env.set_var(name, "?");
                return ShellResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: String::new(),
                };
            }

            let arg = &args_to_parse[optind - 1];

            // Check if this is an option
            if !arg.starts_with('-') || arg == "-" || arg == "--" {
                let _ = env.set_var(name, "?");
                if arg == "--" {
                    let _ = env.set_var("OPTIND", &(optind + 1).to_string());
                }
                return ShellResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: String::new(),
                };
            }

            // Parse the option (skip the -)
            let opt_char = arg.chars().nth(1).unwrap_or('?');

            // Check if option is in optstring
            if let Some(pos) = optstring.find(opt_char) {
                let _ = env.set_var(name, &opt_char.to_string());

                // Check if option takes an argument (followed by : in optstring)
                let needs_arg = optstring.chars().nth(pos + 1) == Some(':');

                if needs_arg {
                    // Argument can be attached (-oarg) or next arg (-o arg)
                    if arg.len() > 2 {
                        // Attached argument
                        let optarg = &arg[2..];
                        let _ = env.set_var("OPTARG", optarg);
                        let _ = env.set_var("OPTIND", &(optind + 1).to_string());
                    } else if optind < args_to_parse.len() {
                        // Next argument
                        let optarg = &args_to_parse[optind];
                        let _ = env.set_var("OPTARG", optarg);
                        let _ = env.set_var("OPTIND", &(optind + 2).to_string());
                    } else {
                        // Missing argument
                        let _ = env.set_var(name, "?");
                        let _ = env.set_var("OPTARG", "");
                        return ShellResult::error(
                            format!("getopts: option requires an argument -- {}", opt_char),
                            1,
                        );
                    }
                } else {
                    let _ = env.set_var("OPTARG", "");
                    let _ = env.set_var("OPTIND", &(optind + 1).to_string());
                }

                return ShellResult::success("");
            } else {
                // Unknown option
                let _ = env.set_var(name, "?");
                let _ = env.set_var("OPTARG", &opt_char.to_string());
                let _ = env.set_var("OPTIND", &(optind + 1).to_string());

                // Silent error if optstring starts with :
                if !optstring.starts_with(':') {
                    return ShellResult::error(
                        format!("getopts: illegal option -- {}", opt_char),
                        0,
                    );
                }
                return ShellResult::success("");
            }
        }

        _ => {}
    }

    // Check if this is a function call
    if let Some(body) = env.functions.get(&expanded_name).cloned() {
        return call_function(&body, &expanded_args, env, stdin).await;
    }

    // Check if this is a lazy-loadable command FIRST (before built-in commands)
    // This allows lazy modules like git-module to handle commands even if there's a stub
    #[cfg(target_arch = "wasm32")]
    {
        use crate::bindings::mcp::module_loader::loader;

        if let Some(module_name) = loader::get_lazy_module(&expanded_name) {
            // Command needs a lazy module - spawn it via frontend
            let exec_env = loader::ExecEnv {
                cwd: env.cwd.to_string_lossy().to_string(),
                vars: env
                    .env_vars
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            };

            // Query the module registry to check if this is an interactive TUI command
            // This moves the knowledge from Rust hardcoded list to the frontend module registry
            let is_interactive_tui = loader::is_interactive_command(&expanded_name);

            if is_interactive_tui {
                // Interactive TUI command - use spawn_interactive with terminal streams
                // Get terminal size (use default 80x24 if not available)
                let size = loader::TerminalSize { cols: 80, rows: 24 };

                let process = loader::spawn_interactive(
                    &module_name,
                    &expanded_name,
                    &expanded_args,
                    &exec_env,
                    size,
                );

                // Wait for module to load
                let ready_pollable = process.get_ready_pollable();
                ready_pollable.block();

                if !process.is_ready() {
                    return ShellResult::error(
                        format!(
                            "{}: failed to load lazy module '{}'",
                            expanded_name, module_name
                        ),
                        127,
                    );
                }

                // Execute immediately - streams are connected to terminal by the frontend
                process.set_raw_mode(true);

                // For interactive TUI, we don't buffer stdin - the frontend connects
                // the terminal streams directly. We just wait for completion.
                loop {
                    if let Some(code) = process.try_wait() {
                        return ShellResult {
                            stdout: String::new(),
                            stderr: String::new(),
                            code,
                        };
                    }
                }
            } else {
                // Batch command - choose execution strategy based on JSPI availability
                //
                // JSPI mode (Chrome): Use spawn_lazy_command which runs in the same context.
                // This avoids module duplication issues where JCO's instanceof checks fail
                // because the Worker has different class instances.
                //
                // Non-JSPI mode (Safari/Firefox): Use spawn_worker_command for interruptible
                // execution via Worker.terminate().
                let process = if loader::has_jspi() {
                    loader::spawn_lazy_command(
                        &module_name,
                        &expanded_name,
                        &expanded_args,
                        &exec_env,
                    )
                } else {
                    loader::spawn_worker_command(&expanded_name, &expanded_args, &exec_env)
                };

                // Wait for the module to be loaded before writing stdin
                // Get the ready pollable and block on it
                let ready_pollable = process.get_ready_pollable();
                ready_pollable.block();

                // Verify module is ready
                if !process.is_ready() {
                    return ShellResult::error(
                        format!(
                            "{}: failed to load lazy module '{}'",
                            expanded_name, module_name
                        ),
                        127,
                    );
                }

                // Get stdin data and write it to the process
                let stdin_data = match get_stdin_data(stdin, redirects, env) {
                    Ok(data) => data,
                    Err(err_result) => return err_result,
                };
                if let Some(data) = stdin_data {
                    // Stream stdin in chunks to avoid memory issues
                    let mut offset = 0;
                    while offset < data.len() {
                        let chunk = &data[offset..std::cmp::min(offset + 65536, data.len())];
                        let written = process.write_stdin(chunk);
                        if written == 0 {
                            break;
                        }
                        offset += written as usize;
                    }
                }
                process.close_stdin();

                // Stream stdout and stderr while waiting for completion
                let mut stdout_buf = Vec::new();
                let mut stderr_buf = Vec::new();

                loop {
                    // Read available output
                    let stdout_chunk = process.read_stdout(65536);
                    if !stdout_chunk.is_empty() {
                        stdout_buf.extend_from_slice(&stdout_chunk);
                    }

                    let stderr_chunk = process.read_stderr(65536);
                    if !stderr_chunk.is_empty() {
                        stderr_buf.extend_from_slice(&stderr_chunk);
                    }

                    // Check if process completed
                    if let Some(code) = process.try_wait() {
                        // Drain remaining output
                        loop {
                            let chunk = process.read_stdout(65536);
                            if chunk.is_empty() {
                                break;
                            }
                            stdout_buf.extend_from_slice(&chunk);
                        }
                        loop {
                            let chunk = process.read_stderr(65536);
                            if chunk.is_empty() {
                                break;
                            }
                            stderr_buf.extend_from_slice(&chunk);
                        }

                        // Handle output redirects
                        let (stdout, stderr) = handle_output_redirects(
                            stdout_buf,
                            stderr_buf,
                            redirects,
                            &env.cwd.to_string_lossy(),
                        );
                        return ShellResult {
                            stdout,
                            stderr,
                            code,
                        };
                    }
                }
            }
        }
    }

    // Get the built-in command implementation (after checking lazy modules)
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
    let code = cmd_fn(
        expanded_args,
        env,
        stdin_reader,
        stdout_writer,
        stderr_writer,
    )
    .await;

    // Collect output
    let stdout_bytes = drain_reader(stdout_reader).await;
    let stderr_bytes = drain_reader(stderr_reader).await;

    // Handle output redirects
    let (stdout, stderr) = handle_output_redirects(
        stdout_bytes,
        stderr_bytes,
        redirects,
        &env.cwd.to_string_lossy(),
    );

    ShellResult {
        stdout,
        stderr,
        code,
    }
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
                        'f' => env.options.noglob = enable,
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
            output.push_str(&format!(
                "shopt {} {}\n",
                if value { "-s" } else { "-u" },
                name
            ));
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
        Ok(parsed) if !parsed.is_empty() => Box::pin(execute_sequence(&parsed, env, stdin)).await,
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

    // Enter loop scope
    env.loop_depth += 1;

    'outer: for word in expanded_words {
        let _ = env.set_var(var, &word);

        for cmd in body {
            let result = Box::pin(execute_command(cmd, env, None)).await;
            combined_stdout.push_str(&result.stdout);
            combined_stderr.push_str(&result.stderr);
            last_code = result.code;

            // Check for break
            if env.break_level > 0 {
                env.break_level -= 1;
                if env.break_level == 0 {
                    // Break this loop
                    break 'outer;
                } else {
                    // Propagate break to outer loop
                    env.loop_depth -= 1;
                    return ShellResult {
                        stdout: combined_stdout,
                        stderr: combined_stderr,
                        code: last_code,
                    };
                }
            }

            // Check for continue
            if env.continue_level > 0 {
                env.continue_level -= 1;
                if env.continue_level == 0 {
                    // Continue this loop
                    continue 'outer;
                } else {
                    // Propagate continue to outer loop
                    env.loop_depth -= 1;
                    return ShellResult {
                        stdout: combined_stdout,
                        stderr: combined_stderr,
                        code: last_code,
                    };
                }
            }
        }
    }

    // Exit loop scope
    env.loop_depth -= 1;

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

    // Enter loop scope
    env.loop_depth += 1;

    'outer: loop {
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

            // Check for break
            if env.break_level > 0 {
                env.break_level -= 1;
                if env.break_level == 0 {
                    // Break this loop
                    break 'outer;
                } else {
                    // Propagate break to outer loop
                    env.loop_depth -= 1;
                    return ShellResult {
                        stdout: combined_stdout,
                        stderr: combined_stderr,
                        code: last_code,
                    };
                }
            }

            // Check for continue
            if env.continue_level > 0 {
                env.continue_level -= 1;
                if env.continue_level == 0 {
                    // Continue this loop
                    continue 'outer;
                } else {
                    // Propagate continue to outer loop
                    env.loop_depth -= 1;
                    return ShellResult {
                        stdout: combined_stdout,
                        stderr: combined_stderr,
                        code: last_code,
                    };
                }
            }
        }
    }

    // Exit loop scope
    env.loop_depth -= 1;

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
    let expanded_word =
        expand::expand_string(word, env, false).unwrap_or_else(|_| word.to_string());

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
        ParsedCommand::Simple {
            name,
            args,
            env_vars,
            ..
        } => {
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
            format!(
                "for {} in {}; do {}; done",
                var,
                words.join(" "),
                body_strs.join("; ")
            )
        }
        ParsedCommand::While { condition, body } => {
            let cond_strs: Vec<String> = condition.iter().map(to_shell_string).collect();
            let body_strs: Vec<String> = body.iter().map(to_shell_string).collect();
            format!(
                "while {}; do {}; done",
                cond_strs.join("; "),
                body_strs.join("; ")
            )
        }
        ParsedCommand::If {
            conditionals,
            else_branch,
        } => {
            let mut result = String::new();
            for (i, (cond, body)) in conditionals.iter().enumerate() {
                let cond_strs: Vec<String> = cond.iter().map(to_shell_string).collect();
                let body_strs: Vec<String> = body.iter().map(to_shell_string).collect();
                if i == 0 {
                    result.push_str(&format!(
                        "if {}; then {}",
                        cond_strs.join("; "),
                        body_strs.join("; ")
                    ));
                } else {
                    result.push_str(&format!(
                        "; elif {}; then {}",
                        cond_strs.join("; "),
                        body_strs.join("; ")
                    ));
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
                result.push_str(&format!(
                    "{}) {};; ",
                    patterns.join("|"),
                    body_strs.join("; ")
                ));
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
            return ShellResult::error(
                format!(
                    "cd: {}: Not a directory",
                    args.get(0).unwrap_or(&"~".to_string())
                ),
                1,
            );
        }
    } else {
        return ShellResult::error(
            format!(
                "cd: {}: No such file or directory",
                args.get(0).unwrap_or(&"~".to_string())
            ),
            1,
        );
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
        let result = futures_lite::future::block_on(run_shell("echo hello | { cat; }", &mut env));
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
