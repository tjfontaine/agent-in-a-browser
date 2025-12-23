//! Text processing commands: grep, wc, sort, uniq, head, tail, tee

use futures_lite::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use futures_lite::StreamExt;
use lexopt::prelude::*;
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::{make_parser, parse_common};

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

    /// sed - stream editor (basic s/// substitution)
    #[shell_command(
        name = "sed",
        usage = "sed 's/PATTERN/REPLACEMENT/[g]' [FILE]...",
        description = "Stream editor for text substitution"
    )]
    fn cmd_sed(
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
                if let Some(help) = TextCommands::show_help("sed") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                let _ = stderr.write_all(b"sed: missing script\n").await;
                return 1;
            }
            
            // Parse s/pattern/replacement/flags
            let script = &remaining[0];
            let (pattern, replacement, global) = match parse_sed_script(script) {
                Some(parsed) => parsed,
                None => {
                    let _ = stderr.write_all(b"sed: invalid script (use s/pattern/replacement/[g])\n").await;
                    return 1;
                }
            };
            
            let files: Vec<_> = remaining[1..].to_vec();
            
            let process_line = |line: &str| -> String {
                if global {
                    line.replace(&pattern, &replacement)
                } else {
                    line.replacen(&pattern, &replacement, 1)
                }
            };
            
            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut lines = reader.lines();
                while let Some(Ok(line)) = lines.next().await {
                    let result = process_line(&line);
                    let _ = stdout.write_all(result.as_bytes()).await;
                    let _ = stdout.write_all(b"\n").await;
                }
            } else {
                for file in files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };
                    
                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                let result = process_line(line);
                                let _ = stdout.write_all(result.as_bytes()).await;
                                let _ = stdout.write_all(b"\n").await;
                            }
                        }
                        Err(e) => {
                            let msg = format!("sed: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
                }
            }
            0
        })
    }

    /// cut - extract columns from text
    #[shell_command(
        name = "cut",
        usage = "cut -d DELIM -f FIELDS [FILE]...",
        description = "Extract columns from each line"
    )]
    fn cmd_cut(
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
                if let Some(help) = TextCommands::show_help("cut") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut delimiter = '\t';
            let mut fields: Vec<usize> = Vec::new();
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('d') => {
                        if let Ok(val) = parser.value() {
                            let s = val.string().unwrap_or_default();
                            delimiter = s.chars().next().unwrap_or('\t');
                        }
                    }
                    Short('f') => {
                        if let Ok(val) = parser.value() {
                            let s = val.string().unwrap_or_default();
                            fields = parse_field_spec(&s);
                        }
                    }
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            if fields.is_empty() {
                let _ = stderr.write_all(b"cut: you must specify a list of fields\n").await;
                return 1;
            }
            
            let extract = |line: &str| -> String {
                let parts: Vec<&str> = line.split(delimiter).collect();
                let selected: Vec<&str> = fields.iter()
                    .filter_map(|&f| parts.get(f.saturating_sub(1)))
                    .copied()
                    .collect();
                selected.join(&delimiter.to_string())
            };
            
            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut lines = reader.lines();
                while let Some(Ok(line)) = lines.next().await {
                    let result = extract(&line);
                    let _ = stdout.write_all(result.as_bytes()).await;
                    let _ = stdout.write_all(b"\n").await;
                }
            } else {
                for file in files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };
                    
                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                let result = extract(line);
                                let _ = stdout.write_all(result.as_bytes()).await;
                                let _ = stdout.write_all(b"\n").await;
                            }
                        }
                        Err(e) => {
                            let msg = format!("cut: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
                }
            }
            0
        })
    }

    /// tr - translate or delete characters
    #[shell_command(
        name = "tr",
        usage = "tr [-d] SET1 [SET2]",
        description = "Translate or delete characters"
    )]
    fn cmd_tr(
        args: Vec<String>,
        _env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TextCommands::show_help("tr") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut delete_mode = false;
            let mut positional: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('d') => delete_mode = true,
                    Value(val) => positional.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            if positional.is_empty() {
                let _ = stderr.write_all(b"tr: missing operand\n").await;
                return 1;
            }
            
            let set1: Vec<char> = expand_char_set(&positional[0]);
            let set2: Vec<char> = if positional.len() > 1 {
                expand_char_set(&positional[1])
            } else {
                Vec::new()
            };
            
            let reader = BufReader::new(stdin);
            let mut lines = reader.lines();
            
            while let Some(Ok(line)) = lines.next().await {
                let result: String = line.chars().filter_map(|c| {
                    if let Some(pos) = set1.iter().position(|&x| x == c) {
                        if delete_mode {
                            None
                        } else if pos < set2.len() {
                            Some(set2[pos])
                        } else if !set2.is_empty() {
                            Some(*set2.last().unwrap())
                        } else {
                            Some(c)
                        }
                    } else {
                        Some(c)
                    }
                }).collect();
                let _ = stdout.write_all(result.as_bytes()).await;
                let _ = stdout.write_all(b"\n").await;
            }
            0
        })
    }
}

/// Parse a sed s/pattern/replacement/flags script
fn parse_sed_script(script: &str) -> Option<(String, String, bool)> {
    if !script.starts_with("s") || script.len() < 4 {
        return None;
    }
    
    let delim = script.chars().nth(1)?;
    let rest = &script[2..];
    
    let parts: Vec<&str> = rest.split(delim).collect();
    if parts.len() < 2 {
        return None;
    }
    
    let pattern = parts[0].to_string();
    let replacement = parts[1].to_string();
    let global = parts.get(2).map(|f| f.contains('g')).unwrap_or(false);
    
    Some((pattern, replacement, global))
}

/// Parse field specification like "1,3" or "2-4" 
fn parse_field_spec(spec: &str) -> Vec<usize> {
    let mut fields = Vec::new();
    for part in spec.split(',') {
        if part.contains('-') {
            let range: Vec<&str> = part.splitn(2, '-').collect();
            if range.len() == 2 {
                if let (Ok(start), Ok(end)) = (range[0].parse::<usize>(), range[1].parse::<usize>()) {
                    for i in start..=end {
                        fields.push(i);
                    }
                }
            }
        } else if let Ok(n) = part.parse::<usize>() {
            fields.push(n);
        }
    }
    fields
}

/// Expand character set notation (e.g., "a-z" -> all lowercase letters)
fn expand_char_set(s: &str) -> Vec<char> {
    let mut result = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    
    while i < chars.len() {
        if i + 2 < chars.len() && chars[i + 1] == '-' {
            // Range like a-z
            let start = chars[i] as u32;
            let end = chars[i + 2] as u32;
            for c in start..=end {
                if let Some(ch) = char::from_u32(c) {
                    result.push(ch);
                }
            }
            i += 3;
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_sed_script_basic() {
        let result = parse_sed_script("s/foo/bar/");
        assert!(result.is_some());
        let (pattern, replacement, global) = result.unwrap();
        assert_eq!(pattern, "foo");
        assert_eq!(replacement, "bar");
        assert!(!global);
    }

    #[test]
    fn test_parse_sed_script_global() {
        let result = parse_sed_script("s/foo/bar/g");
        assert!(result.is_some());
        let (_, _, global) = result.unwrap();
        assert!(global);
    }

    #[test]
    fn test_parse_sed_script_different_delimiter() {
        let result = parse_sed_script("s|path/to/file|new/path|g");
        assert!(result.is_some());
        let (pattern, replacement, global) = result.unwrap();
        assert_eq!(pattern, "path/to/file");
        assert_eq!(replacement, "new/path");
        assert!(global);
    }

    #[test]
    fn test_parse_sed_script_invalid() {
        assert!(parse_sed_script("").is_none());
        assert!(parse_sed_script("s").is_none());
        assert!(parse_sed_script("s/").is_none());
        assert!(parse_sed_script("x/foo/bar/").is_none());
    }

    #[test]
    fn test_parse_field_spec_single() {
        assert_eq!(parse_field_spec("1"), vec![1]);
        assert_eq!(parse_field_spec("3"), vec![3]);
    }

    #[test]
    fn test_parse_field_spec_multiple() {
        assert_eq!(parse_field_spec("1,3"), vec![1, 3]);
        assert_eq!(parse_field_spec("1,2,4"), vec![1, 2, 4]);
    }

    #[test]
    fn test_parse_field_spec_range() {
        assert_eq!(parse_field_spec("1-3"), vec![1, 2, 3]);
        assert_eq!(parse_field_spec("2-4"), vec![2, 3, 4]);
    }

    #[test]
    fn test_parse_field_spec_mixed() {
        assert_eq!(parse_field_spec("1,3-5,7"), vec![1, 3, 4, 5, 7]);
    }

    #[test]
    fn test_expand_char_set_simple() {
        assert_eq!(expand_char_set("abc"), vec!['a', 'b', 'c']);
    }

    #[test]
    fn test_expand_char_set_range() {
        assert_eq!(expand_char_set("a-e"), vec!['a', 'b', 'c', 'd', 'e']);
    }

    #[test]
    fn test_expand_char_set_digits() {
        assert_eq!(expand_char_set("0-9"), 
            vec!['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    }

    #[test]
    fn test_expand_char_set_mixed() {
        assert_eq!(expand_char_set("a-cx"), vec!['a', 'b', 'c', 'x']);
    }
}
