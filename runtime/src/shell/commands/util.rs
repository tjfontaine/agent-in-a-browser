//! Additional utility commands: printf, read, stat, ln, mktemp, type, which

use futures_lite::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::{parse_common, ShellCommands};

// Import WASI random bindings for cryptographic randomness
use crate::bindings::wasi::random::random as wasi_random;

/// Additional utility commands.
pub struct UtilCommands;

#[shell_commands]
impl UtilCommands {
    /// printf - format and print data
    #[shell_command(
        name = "printf",
        usage = "printf FORMAT [ARGUMENT]...",
        description = "Format and print ARGUMENTS under control of FORMAT.\n\
        Format specifiers: %s (string), %d (decimal), %x (hex), %o (octal), %c (char), %% (literal %)\n\
        Escape sequences: \\n, \\t, \\r, \\\\, \\0NNN"
    )]
    pub fn cmd_printf(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                let help = UtilCommands::show_help("printf").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            if remaining.is_empty() {
                let _ = stderr.write_all(b"printf: missing format\n").await;
                return 1;
            }

            let format = &remaining[0];
            let arguments = &remaining[1..];
            let mut arg_idx = 0;

            let output = format_printf(format, arguments, &mut arg_idx);
            let _ = stdout.write_all(output.as_bytes()).await;

            0
        })
    }

    /// read - read a line from stdin into a variable
    #[shell_command(
        name = "read",
        usage = "read [-r] [-p PROMPT] VAR...",
        description = "Read a line from stdin and split it into variables.\n\
        -r: Do not treat backslashes as escape characters\n\
        -p PROMPT: Output PROMPT before reading"
    )]
    pub fn cmd_read(
        args: Vec<String>,
        _env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                let help = UtilCommands::show_help("read").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let mut raw_mode = false;
            let mut prompt = None;
            let mut var_names = Vec::new();
            let mut i = 0;

            while i < remaining.len() {
                match remaining[i].as_str() {
                    "-r" => raw_mode = true,
                    "-p" => {
                        i += 1;
                        if i < remaining.len() {
                            prompt = Some(remaining[i].clone());
                        }
                    }
                    s if !s.starts_with('-') => {
                        var_names.push(s.to_string());
                    }
                    _ => {}
                }
                i += 1;
            }

            if var_names.is_empty() {
                var_names.push("REPLY".to_string());
            }

            // Print prompt if specified
            if let Some(p) = prompt {
                let _ = stdout.write_all(p.as_bytes()).await;
            }

            // Read a line from stdin
            let mut reader = BufReader::new(stdin);
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => return 1, // EOF
                Ok(_) => {}
                Err(_) => return 1,
            }

            // Trim trailing newline
            let line = line.trim_end_matches('\n').trim_end_matches('\r');

            // Process backslashes if not in raw mode
            let line = if raw_mode {
                line.to_string()
            } else {
                line.replace("\\n", "\n").replace("\\t", "\t")
            };

            // Output variable assignments (the caller will need to capture these)
            // In a real shell, we'd set env variables directly
            // For now, we output in a format the caller can parse
            let words: Vec<&str> = line.split_whitespace().collect();

            for (i, name) in var_names.iter().enumerate() {
                let value = if i == var_names.len() - 1 {
                    // Last variable gets remainder
                    words[i..].join(" ")
                } else {
                    words.get(i).unwrap_or(&"").to_string()
                };
                let _ = stdout
                    .write_all(format!("{}={}\n", name, value).as_bytes())
                    .await;
            }

            0
        })
    }

    /// stat - display file status
    #[shell_command(
        name = "stat",
        usage = "stat [FILE]...",
        description = "Display file or file system status."
    )]
    pub fn cmd_stat(
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
                let help = UtilCommands::show_help("stat").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            if remaining.is_empty() {
                let _ = stderr.write_all(b"stat: missing operand\n").await;
                return 1;
            }

            // cwd already cloned above
            let mut exit_code = 0;

            for file in &remaining {
                let path = if file.starts_with('/') {
                    file.clone()
                } else {
                    format!("{}/{}", cwd, file)
                };

                match std::fs::metadata(&path) {
                    Ok(metadata) => {
                        let file_type = if metadata.is_dir() {
                            "directory"
                        } else if metadata.is_file() {
                            "regular file"
                        } else {
                            "other"
                        };

                        let _ = stdout
                            .write_all(
                                format!(
                                    "  File: {}\n  Size: {}\t\tType: {}\n",
                                    file,
                                    metadata.len(),
                                    file_type
                                )
                                .as_bytes(),
                            )
                            .await;

                        // Try to get times
                        if let Ok(modified) = metadata.modified() {
                            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                                let _ = stdout
                                    .write_all(
                                        format!("Modify: {}\n", duration.as_secs()).as_bytes(),
                                    )
                                    .await;
                            }
                        }
                    }
                    Err(e) => {
                        let _ = stderr
                            .write_all(format!("stat: {}: {}\n", file, e).as_bytes())
                            .await;
                        exit_code = 1;
                    }
                }
            }

            exit_code
        })
    }

    /// ln - create links
    #[shell_command(
        name = "ln",
        usage = "ln [-s] TARGET LINK_NAME",
        description = "Create a link to TARGET.\n\
        -s: Create symbolic link"
    )]
    pub fn cmd_ln(
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
                let help = UtilCommands::show_help("ln").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let mut symbolic = false;
            let mut paths = Vec::new();

            for arg in &remaining {
                match arg.as_str() {
                    "-s" => symbolic = true,
                    s if !s.starts_with('-') => paths.push(s.to_string()),
                    _ => {}
                }
            }

            if paths.len() < 2 {
                let _ = stderr.write_all(b"ln: missing operand\n").await;
                return 1;
            }

            // cwd already cloned above
            let target = if paths[0].starts_with('/') {
                paths[0].clone()
            } else {
                format!("{}/{}", cwd, paths[0])
            };

            let link_name = if paths[1].starts_with('/') {
                paths[1].clone()
            } else {
                format!("{}/{}", cwd, paths[1])
            };

            let result = if symbolic {
                #[cfg(unix)]
                {
                    std::os::unix::fs::symlink(&target, &link_name)
                }
                #[cfg(not(unix))]
                {
                    // On non-Unix, copy the file instead
                    std::fs::copy(&target, &link_name).map(|_| ())
                }
            } else {
                std::fs::hard_link(&target, &link_name)
            };

            match result {
                Ok(_) => 0,
                Err(e) => {
                    let _ = stderr.write_all(format!("ln: {}\n", e).as_bytes()).await;
                    1
                }
            }
        })
    }

    /// mktemp - create a temporary file or directory
    #[shell_command(
        name = "mktemp",
        usage = "mktemp [-d] [TEMPLATE]",
        description = "Create a temporary file or directory.\n\
        -d: Create a directory instead of a file\n\
        TEMPLATE must end in XXXXXX"
    )]
    pub fn cmd_mktemp(
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
                let help = UtilCommands::show_help("mktemp").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let mut directory = false;
            let mut template = "tmp.XXXXXX".to_string();

            for arg in &remaining {
                match arg.as_str() {
                    "-d" => directory = true,
                    s if !s.starts_with('-') => template = s.to_string(),
                    _ => {}
                }
            }

            // Generate random suffix using WASI random for proper WASM compatibility
            let random_bytes = wasi_random::get_random_bytes(6);
            let charset = b"abcdefghijklmnopqrstuvwxyz0123456789";
            let suffix: String = random_bytes
                .iter()
                .map(|byte| {
                    let idx = (*byte as usize) % charset.len();
                    charset[idx] as char
                })
                .collect();

            let path = template.replace("XXXXXX", &suffix);
            let full_path = if path.starts_with('/') {
                path
            } else {
                format!("{}/{}", cwd, path)
            };

            let result = if directory {
                std::fs::create_dir_all(&full_path)
            } else {
                std::fs::write(&full_path, "").map(|_| ())
            };

            match result {
                Ok(_) => {
                    let _ = stdout
                        .write_all(format!("{}\n", full_path).as_bytes())
                        .await;
                    0
                }
                Err(e) => {
                    let _ = stderr
                        .write_all(format!("mktemp: {}\n", e).as_bytes())
                        .await;
                    1
                }
            }
        })
    }

    /// type - describe a command
    #[shell_command(
        name = "type",
        usage = "type NAME...",
        description = "Describe how NAME would be interpreted if used as a command."
    )]
    pub fn cmd_type(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                let help = UtilCommands::show_help("type").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let mut exit_code = 0;

            for name in &remaining {
                if ShellCommands::get_command(name).is_some() {
                    let _ = stdout
                        .write_all(format!("{} is a shell builtin\n", name).as_bytes())
                        .await;
                } else if is_shell_keyword(name) {
                    let _ = stdout
                        .write_all(format!("{} is a shell keyword\n", name).as_bytes())
                        .await;
                } else {
                    let _ = stderr
                        .write_all(format!("type: {}: not found\n", name).as_bytes())
                        .await;
                    exit_code = 1;
                }
            }

            exit_code
        })
    }

    /// which - locate a command
    #[shell_command(
        name = "which",
        usage = "which NAME...",
        description = "Locate a command."
    )]
    pub fn cmd_which(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                let help = UtilCommands::show_help("which").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let mut exit_code = 0;

            for name in &remaining {
                if ShellCommands::get_command(name).is_some() {
                    let _ = stdout
                        .write_all(format!("{}: shell builtin\n", name).as_bytes())
                        .await;
                } else {
                    let _ = stderr
                        .write_all(format!("{}: not found\n", name).as_bytes())
                        .await;
                    exit_code = 1;
                }
            }

            exit_code
        })
    }
}

/// Format printf string with arguments
fn format_printf(format: &str, args: &[String], arg_idx: &mut usize) -> String {
    let mut result = String::new();
    let mut chars = format.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '%' => match chars.peek() {
                Some('%') => {
                    chars.next();
                    result.push('%');
                }
                Some('s') => {
                    chars.next();
                    if let Some(arg) = args.get(*arg_idx) {
                        result.push_str(arg);
                        *arg_idx += 1;
                    }
                }
                Some('d') | Some('i') => {
                    chars.next();
                    if let Some(arg) = args.get(*arg_idx) {
                        let num: i64 = arg.parse().unwrap_or(0);
                        result.push_str(&num.to_string());
                        *arg_idx += 1;
                    }
                }
                Some('x') => {
                    chars.next();
                    if let Some(arg) = args.get(*arg_idx) {
                        let num: i64 = arg.parse().unwrap_or(0);
                        result.push_str(&format!("{:x}", num));
                        *arg_idx += 1;
                    }
                }
                Some('X') => {
                    chars.next();
                    if let Some(arg) = args.get(*arg_idx) {
                        let num: i64 = arg.parse().unwrap_or(0);
                        result.push_str(&format!("{:X}", num));
                        *arg_idx += 1;
                    }
                }
                Some('o') => {
                    chars.next();
                    if let Some(arg) = args.get(*arg_idx) {
                        let num: i64 = arg.parse().unwrap_or(0);
                        result.push_str(&format!("{:o}", num));
                        *arg_idx += 1;
                    }
                }
                Some('c') => {
                    chars.next();
                    if let Some(arg) = args.get(*arg_idx) {
                        if let Some(c) = arg.chars().next() {
                            result.push(c);
                        }
                        *arg_idx += 1;
                    }
                }
                _ => {
                    result.push('%');
                }
            },
            '\\' => {
                match chars.next() {
                    Some('n') => result.push('\n'),
                    Some('t') => result.push('\t'),
                    Some('r') => result.push('\r'),
                    Some('\\') => result.push('\\'),
                    Some('0') => {
                        // Octal escape
                        let mut oct = String::new();
                        for _ in 0..3 {
                            if let Some(&c) = chars.peek() {
                                if c >= '0' && c <= '7' {
                                    oct.push(chars.next().unwrap());
                                } else {
                                    break;
                                }
                            }
                        }
                        if let Ok(n) = u8::from_str_radix(&oct, 8) {
                            result.push(n as char);
                        }
                    }
                    Some(c) => {
                        result.push('\\');
                        result.push(c);
                    }
                    None => result.push('\\'),
                }
            }
            _ => result.push(c),
        }
    }

    result
}

/// Check if a name is a shell keyword
fn is_shell_keyword(name: &str) -> bool {
    matches!(
        name,
        "if" | "then"
            | "else"
            | "elif"
            | "fi"
            | "for"
            | "while"
            | "until"
            | "do"
            | "done"
            | "case"
            | "esac"
            | "in"
            | "function"
            | "{"
            | "}"
            | "!"
            | "[["
            | "]]"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_printf_string() {
        let mut idx = 0;
        assert_eq!(
            format_printf("Hello %s!", &["world".to_string()], &mut idx),
            "Hello world!"
        );
    }

    #[test]
    fn test_printf_number() {
        let mut idx = 0;
        assert_eq!(
            format_printf("Number: %d", &["42".to_string()], &mut idx),
            "Number: 42"
        );
    }

    #[test]
    fn test_printf_hex() {
        let mut idx = 0;
        assert_eq!(
            format_printf("Hex: %x", &["255".to_string()], &mut idx),
            "Hex: ff"
        );
    }

    #[test]
    fn test_printf_escape() {
        let mut idx = 0;
        assert_eq!(
            format_printf("Line1\\nLine2", &[], &mut idx),
            "Line1\nLine2"
        );
    }
}
