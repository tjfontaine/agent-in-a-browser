//! Brush Shell - Interactive POSIX-compatible shell
//!
//! A simple interactive shell that:
//! - Displays a prompt and reads lines from stdin
//! - Executes commands using built-in implementations
//! - Supports basic shell features (cd, echo, pwd, env vars)
//!
//! This is the primary entry point for interactive shell mode.

#[allow(warnings)]
mod bindings;

use bindings::exports::shell::unix::command::{ExecEnv, Guest};
use bindings::wasi::io::streams::{InputStream, OutputStream};

mod line_editor;
use line_editor::LineEditor;

struct BrushShell;

impl Guest for BrushShell {
    fn run(
        name: String,
        _args: Vec<String>,
        env: ExecEnv,
        stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) -> i32 {
        match name.as_str() {
            "sh" | "shell" | "bash" | "brush-shell" => {
                run_shell(env, stdin, stdout, stderr)
            }
            _ => {
                write_str(&stderr, &format!("Unknown command: {}\n", name));
                127
            }
        }
    }

    fn list_commands() -> Vec<String> {
        vec![
            "sh".to_string(),
            "shell".to_string(),
            "bash".to_string(),
            "brush-shell".to_string(),
        ]
    }
}

/// Shell state - tracks cwd, environment variables, etc.
struct ShellState {
    cwd: String,
    env_vars: Vec<(String, String)>,
}

impl ShellState {
    fn new(env: &ExecEnv) -> Self {
        Self {
            cwd: env.cwd.clone(),
            env_vars: env.vars.clone(),
        }
    }
    
    fn get_var(&self, name: &str) -> Option<&str> {
        self.env_vars.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    
    fn set_var(&mut self, name: String, value: String) {
        // Update existing or add new
        if let Some((_, v)) = self.env_vars.iter_mut().find(|(k, _)| k == &name) {
            *v = value;
        } else {
            self.env_vars.push((name, value));
        }
    }
}

/// Main shell REPL loop
fn run_shell(
    env: ExecEnv,
    stdin: InputStream,
    stdout: OutputStream,
    stderr: OutputStream,
) -> i32 {
    let mut state = ShellState::new(&env);
    let mut editor = LineEditor::new();
    
    loop {
        // Render prompt
        render_prompt(&stdout, &state);
        
        // Read a line from stdin
        match editor.read_line(&stdin, &stdout) {
            line_editor::LineResult::Line(line) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                
                // Check for exit command
                if line == "exit" || line.starts_with("exit ") {
                    write_str(&stdout, "Bye!\n");
                    return 0;
                }
                
                // Execute the command
                execute_command(line, &mut state, &stdout, &stderr);
            }
            line_editor::LineResult::Eof => {
                // Ctrl+D - exit
                write_str(&stdout, "\nexit\n");
                return 0;
            }
            line_editor::LineResult::Interrupt => {
                // Ctrl+C - cancel current line, show new prompt
                write_str(&stdout, "^C\n");
            }
        }
    }
}

/// Render the shell prompt
fn render_prompt(stdout: &OutputStream, state: &ShellState) {
    // Simple prompt for now - just "$ "
    // Future: support PS1 customization
    let prompt = format!("{}$ ", state.cwd);
    write_str(stdout, &prompt);
}

/// Execute a single command line
fn execute_command(
    line: &str,
    state: &mut ShellState,
    stdout: &OutputStream,
    stderr: &OutputStream,
) {
    // Very simple parsing for MVP - split on whitespace
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.is_empty() {
        return;
    }
    
    let cmd = parts[0];
    let args = &parts[1..];
    
    match cmd {
        "cd" => {
            cmd_cd(args, state, stderr);
        }
        "pwd" => {
            write_str(stdout, &format!("{}\n", state.cwd));
        }
        "echo" => {
            cmd_echo(args, state, stdout);
        }
        "export" => {
            cmd_export(args, state, stderr);
        }
        "env" => {
            for (k, v) in &state.env_vars {
                write_str(stdout, &format!("{}={}\n", k, v));
            }
        }
        "help" => {
            write_str(stdout, "Built-in commands: cd, pwd, echo, export, env, help, exit\n");
        }
        _ => {
            // Unknown command
            write_str(stderr, &format!("brush: command not found: {}\n", cmd));
        }
    }
}

/// cd - change directory
fn cmd_cd(args: &[&str], state: &mut ShellState, stderr: &OutputStream) {
    let target = if args.is_empty() {
        // cd with no args goes to home (or /)
        state.get_var("HOME").unwrap_or("/").to_string()
    } else {
        let path = args[0];
        if path.starts_with('/') {
            path.to_string()
        } else if path == ".." {
            // Go up one directory
            let mut parts: Vec<&str> = state.cwd.split('/').filter(|s| !s.is_empty()).collect();
            parts.pop();
            if parts.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", parts.join("/"))
            }
        } else if path == "." {
            state.cwd.clone()
        } else {
            // Relative path
            if state.cwd == "/" {
                format!("/{}", path)
            } else {
                format!("{}/{}", state.cwd, path)
            }
        }
    };
    
    // TODO: validate that directory exists using WASI filesystem
    // For now, just update the state
    state.cwd = target;
}

/// echo - print arguments
fn cmd_echo(args: &[&str], state: &ShellState, stdout: &OutputStream) {
    let output: Vec<String> = args.iter().map(|arg| {
        // Simple variable expansion
        if arg.starts_with('$') {
            let var_name = &arg[1..];
            state.get_var(var_name).unwrap_or("").to_string()
        } else {
            arg.to_string()
        }
    }).collect();
    
    write_str(stdout, &format!("{}\n", output.join(" ")));
}

/// export - set environment variable
fn cmd_export(args: &[&str], state: &mut ShellState, stderr: &OutputStream) {
    for arg in args {
        if let Some(eq_pos) = arg.find('=') {
            let name = &arg[..eq_pos];
            let value = &arg[eq_pos + 1..];
            state.set_var(name.to_string(), value.to_string());
        } else {
            write_str(stderr, &format!("export: invalid format: {}\n", arg));
        }
    }
}

/// Helper to write a string to an output stream
fn write_str(stream: &OutputStream, s: &str) {
    let _ = stream.blocking_write_and_flush(s.as_bytes());
}

bindings::export!(BrushShell with_types_in bindings);
