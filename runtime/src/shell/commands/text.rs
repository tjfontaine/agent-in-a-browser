//! Text processing commands: grep, wc, sort, uniq, head, tail, tee

use futures_lite::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use futures_lite::StreamExt;
use lexopt::prelude::*;
use runtime_macros::{shell_command, shell_commands};

use super::super::ShellEnv;
use super::{make_parser, parse_common, CommandFn};

/// Text processing commands.
pub struct TextCommands;

#[shell_commands]
impl TextCommands {
    /// head - output first N lines (default 10)
    #[shell_command(
        name = "head",
        usage = "head [-n COUNT] [FILE]",
        description = "Output the first part of files"
    )]
    fn cmd_head(
        args: Vec<String>,
        _env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TextCommands::show_help("head") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut count = 10usize;
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('n') | Long("number") => {
                        if let Ok(val) = parser.value() {
                            count = val.string().ok()
                                .and_then(|s| s.parse().ok())
                                .unwrap_or(10);
                        }
                    }
                    _ => {}
                }
            }
            
            let reader = BufReader::new(stdin);
            let mut lines = reader.lines();
            let mut written = 0;

            while written < count {
                match lines.next().await {
                    Some(Ok(line)) => {
                        if stdout.write_all(line.as_bytes()).await.is_err() {
                            break;
                        }
                        if stdout.write_all(b"\n").await.is_err() {
                            break;
                        }
                        written += 1;
                    }
                    Some(Err(_)) => break,
                    None => break,
                }
            }
            0
        })
    }

    /// tail - output last N lines (default 10)
    #[shell_command(
        name = "tail",
        usage = "tail [-n COUNT] [FILE]",
        description = "Output the last part of files"
    )]
    fn cmd_tail(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TextCommands::show_help("tail") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut count = 10usize;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('n') | Long("number") => {
                        if let Ok(val) = parser.value() {
                            count = val.string().ok()
                                .and_then(|s| s.parse().ok())
                                .unwrap_or(10);
                        }
                    }
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            let mut all_lines: Vec<String> = Vec::new();
            
            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut lines_iter = reader.lines();
                while let Some(Ok(line)) = lines_iter.next().await {
                    all_lines.push(line);
                }
            } else {
                for file in &files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };
                    
                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                all_lines.push(line.to_string());
                            }
                        }
                        Err(e) => {
                            let msg = format!("tail: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
                }
            }
            
            let start = if all_lines.len() > count { all_lines.len() - count } else { 0 };
            for line in &all_lines[start..] {
                let _ = stdout.write_all(line.as_bytes()).await;
                let _ = stdout.write_all(b"\n").await;
            }
            0
        })
    }

    /// grep - search for patterns
    #[shell_command(
        name = "grep",
        usage = "grep [-iv] PATTERN [FILE]...",
        description = "Search for patterns in files"
    )]
    fn cmd_grep(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TextCommands::show_help("grep") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut ignore_case = false;
            let mut invert = false;
            let mut positional: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('i') => ignore_case = true,
                    Short('v') => invert = true,
                    Value(val) => positional.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            if positional.is_empty() {
                let _ = stderr.write_all(b"grep: missing pattern\n").await;
                return 1;
            }
            
            let pattern = &positional[0];
            let pattern_lower = pattern.to_lowercase();
            let files: Vec<_> = positional[1..].to_vec();
            let mut found = false;
            
            let matches = |line: &str| -> bool {
                let line_check = if ignore_case { line.to_lowercase() } else { line.to_string() };
                let pat = if ignore_case { &pattern_lower } else { pattern };
                let contains = line_check.contains(pat);
                if invert { !contains } else { contains }
            };
            
            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut lines = reader.lines();
                while let Some(Ok(line)) = lines.next().await {
                    if matches(&line) {
                        let _ = stdout.write_all(line.as_bytes()).await;
                        let _ = stdout.write_all(b"\n").await;
                        found = true;
                    }
                }
            } else {
                let show_filename = files.len() > 1;
                for file in files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };
                    
                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                if matches(line) {
                                    if show_filename {
                                        let _ = stdout.write_all(format!("{}:", file).as_bytes()).await;
                                    }
                                    let _ = stdout.write_all(line.as_bytes()).await;
                                    let _ = stdout.write_all(b"\n").await;
                                    found = true;
                                }
                            }
                        }
                        Err(e) => {
                            let msg = format!("grep: {}: {}\n", file, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                        }
                    }
                }
            }
            
            if found { 0 } else { 1 }
        })
    }

    /// wc - word, line, character count
    #[shell_command(
        name = "wc",
        usage = "wc [-lwc] [FILE]...",
        description = "Print line, word, and byte counts"
    )]
    fn cmd_wc(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TextCommands::show_help("wc") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut show_lines = false;
            let mut show_words = false;
            let mut show_chars = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('l') => show_lines = true,
                    Short('w') => show_words = true,
                    Short('c') => show_chars = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            if !show_lines && !show_words && !show_chars {
                show_lines = true;
                show_words = true;
                show_chars = true;
            }
            
            let count_content = |content: &str| -> (usize, usize, usize) {
                (content.lines().count(), content.split_whitespace().count(), content.len())
            };
            
            let format_counts = |l: usize, w: usize, c: usize, name: Option<&str>| -> String {
                let mut parts = Vec::new();
                if show_lines { parts.push(format!("{:8}", l)); }
                if show_words { parts.push(format!("{:8}", w)); }
                if show_chars { parts.push(format!("{:8}", c)); }
                let mut result = parts.join("");
                if let Some(n) = name {
                    result.push(' ');
                    result.push_str(n);
                }
                result.push('\n');
                result
            };
            
            if files.is_empty() {
                let mut content = String::new();
                let reader = BufReader::new(stdin);
                let mut lines_iter = reader.lines();
                while let Some(Ok(line)) = lines_iter.next().await {
                    content.push_str(&line);
                    content.push('\n');
                }
                let (l, w, c) = count_content(&content);
                let _ = stdout.write_all(format_counts(l, w, c, None).as_bytes()).await;
            } else {
                let mut total = (0, 0, 0);
                for file in &files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };
                    
                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            let (l, w, c) = count_content(&content);
                            total.0 += l;
                            total.1 += w;
                            total.2 += c;
                            let _ = stdout.write_all(format_counts(l, w, c, Some(file)).as_bytes()).await;
                        }
                        Err(e) => {
                            let msg = format!("wc: {}: {}\n", file, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                        }
                    }
                }
                if files.len() > 1 {
                    let _ = stdout.write_all(format_counts(total.0, total.1, total.2, Some("total")).as_bytes()).await;
                }
            }
            0
        })
    }

    /// sort - sort lines
    #[shell_command(
        name = "sort",
        usage = "sort [-r] [FILE]",
        description = "Sort lines of text"
    )]
    fn cmd_sort(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TextCommands::show_help("sort") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut reverse = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('r') => reverse = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            let mut lines: Vec<String> = Vec::new();
            
            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut lines_iter = reader.lines();
                while let Some(Ok(line)) = lines_iter.next().await {
                    lines.push(line);
                }
            } else {
                for file in &files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };
                    
                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                lines.push(line.to_string());
                            }
                        }
                        Err(e) => {
                            let msg = format!("sort: {}: {}\n", file, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
                }
            }
            
            if reverse {
                lines.sort_by(|a, b| b.cmp(a));
            } else {
                lines.sort();
            }
            
            for line in lines {
                let _ = stdout.write_all(line.as_bytes()).await;
                let _ = stdout.write_all(b"\n").await;
            }
            0
        })
    }

    /// uniq - filter adjacent duplicate lines
    #[shell_command(
        name = "uniq",
        usage = "uniq [-c] [FILE]",
        description = "Filter adjacent duplicate lines"
    )]
    fn cmd_uniq(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TextCommands::show_help("uniq") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut show_count = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('c') => show_count = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            let mut all_lines: Vec<String> = Vec::new();
            
            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut lines_iter = reader.lines();
                while let Some(Ok(line)) = lines_iter.next().await {
                    all_lines.push(line);
                }
            } else {
                for file in &files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };
                    
                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                all_lines.push(line.to_string());
                            }
                        }
                        Err(e) => {
                            let msg = format!("uniq: {}: {}\n", file, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
                }
            }
            
            let mut prev: Option<String> = None;
            let mut cnt = 0usize;
            
            for line in all_lines {
                if prev.as_ref() == Some(&line) {
                    cnt += 1;
                } else {
                    if let Some(p) = prev {
                        if show_count {
                            let _ = stdout.write_all(format!("{:7} {}\n", cnt, p).as_bytes()).await;
                        } else {
                            let _ = stdout.write_all(p.as_bytes()).await;
                            let _ = stdout.write_all(b"\n").await;
                        }
                    }
                    prev = Some(line);
                    cnt = 1;
                }
            }
            if let Some(p) = prev {
                if show_count {
                    let _ = stdout.write_all(format!("{:7} {}\n", cnt, p).as_bytes()).await;
                } else {
                    let _ = stdout.write_all(p.as_bytes()).await;
                    let _ = stdout.write_all(b"\n").await;
                }
            }
            0
        })
    }

    /// tee - read stdin, write to stdout and file
    #[shell_command(
        name = "tee",
        usage = "tee [-a] FILE...",
        description = "Read stdin, write to stdout and files"
    )]
    fn cmd_tee(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TextCommands::show_help("tee") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut append = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('a') => append = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            let mut content = Vec::new();
            let mut reader = stdin;
            let mut buf = [0u8; 4096];
            loop {
                match futures_lite::io::AsyncReadExt::read(&mut reader, &mut buf).await {
                    Ok(0) => break,
                    Ok(n) => content.extend_from_slice(&buf[..n]),
                    Err(_) => break,
                }
            }
            
            let _ = stdout.write_all(&content).await;
            
            for file in files {
                let path = if file.starts_with('/') {
                    file.clone()
                } else {
                    format!("{}/{}", cwd, file)
                };
                
                let result = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .append(append)
                    .truncate(!append)
                    .open(&path)
                    .and_then(|mut f| std::io::Write::write_all(&mut f, &content));
                    
                if let Err(e) = result {
                    let msg = format!("tee: {}: {}\n", path, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                }
            }
            0
        })
    }
}
