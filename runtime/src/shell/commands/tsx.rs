//! tsx command - TypeScript/JavaScript execution
//!
//! Execute TypeScript/JavaScript code using the QuickJS runtime.

use futures_lite::io::AsyncWriteExt;
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::parse_common;

/// TypeScript/JavaScript execution commands.
pub struct TsxCommands;

#[shell_commands]
impl TsxCommands {
    /// tsx - execute TypeScript file
    #[shell_command(
        name = "tsx",
        usage = "tsx [-e CODE] [FILE]",
        description = "Execute TypeScript/JavaScript code or file"
    )]
    fn cmd_tsx(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TsxCommands::show_help("tsx") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut inline_code: Option<String> = None;
            let mut input_file: Option<String> = None;
            
            let mut i = 0;
            while i < remaining.len() {
                match remaining[i].as_str() {
                    "-e" | "--eval" => {
                        i += 1;
                        if i < remaining.len() {
                            inline_code = Some(remaining[i].clone());
                        }
                    }
                    s if !s.starts_with('-') => {
                        input_file = Some(s.to_string());
                    }
                    _ => {}
                }
                i += 1;
            }
            
            // Track source for error messages
            let source_name: String;
            let ts_code = if let Some(code) = inline_code {
                source_name = "<inline>".to_string();
                code
            } else if let Some(file) = input_file {
                let path = if file.starts_with('/') {
                    file.clone()
                } else {
                    format!("{}/{}", cwd, file)
                };
                source_name = path.clone();
                
                match std::fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(e) => {
                        let msg = format!("tsx: {}: {}\n", path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                }
            } else {
                let _ = stderr.write_all(b"tsx: no code or file specified\n").await;
                return 1;
            };
            
            // Execute the code using the QuickJS runtime
            match crate::eval_js_with_source(&ts_code, &source_name) {
                Ok(output) => {
                    if !output.is_empty() && output != "undefined" {
                        let _ = stdout.write_all(output.as_bytes()).await;
                        if !output.ends_with('\n') {
                            let _ = stdout.write_all(b"\n").await;
                        }
                    }
                    0
                }
                Err(e) => {
                    // Format error with source location
                    let _ = stderr.write_all(format!("tsx: error in {}\n", source_name).as_bytes()).await;
                    
                    // Try to extract line info from error message
                    let err_str = e.to_string();
                    if err_str.contains("Parse error") || err_str.contains("Evaluation error") {
                        let _ = stderr.write_all(format!("  {}\n", err_str).as_bytes()).await;
                        
                        // Show first few lines of source for context if it's a short snippet
                        let lines: Vec<&str> = ts_code.lines().take(5).collect();
                        if !lines.is_empty() && ts_code.len() < 500 {
                            let _ = stderr.write_all(b"\n  Source:\n").await;
                            for (i, line) in lines.iter().enumerate() {
                                let _ = stderr.write_all(format!("  {:>3} | {}\n", i + 1, line).as_bytes()).await;
                            }
                            if ts_code.lines().count() > 5 {
                                let _ = stderr.write_all(b"      ...\n").await;
                            }
                        }
                    } else {
                        let _ = stderr.write_all(format!("  {}\n", err_str).as_bytes()).await;
                    }
                    1
                }
            }
        })
    }
}
