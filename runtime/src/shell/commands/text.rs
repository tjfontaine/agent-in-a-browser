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
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();

        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = TextCommands::show_help("head") {
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
                            count = val.string().ok().and_then(|s| s.parse().ok()).unwrap_or(10);
                        }
                    }
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            if files.is_empty() {
                // Read from stdin
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
            } else {
                // Read from file(s)
                for file in &files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };

                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            let mut written = 0;
                            for line in content.lines() {
                                if written >= count {
                                    break;
                                }
                                let _ = stdout.write_all(line.as_bytes()).await;
                                let _ = stdout.write_all(b"\n").await;
                                written += 1;
                            }
                        }
                        Err(e) => {
                            let msg = format!("head: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
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
            let mut from_beginning = false; // true when +N is used
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('n') | Long("number") => {
                        if let Ok(val) = parser.value() {
                            if let Ok(s) = val.string() {
                                if let Some(stripped) = s.strip_prefix('+') {
                                    // +N means "output from line N onwards"
                                    from_beginning = true;
                                    count = stripped.parse().unwrap_or(10);
                                } else {
                                    count = s.parse().unwrap_or(10);
                                }
                            }
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

            let start = if from_beginning {
                // +N means start from line N (1-based), so skip N-1 lines
                if count > 0 {
                    count - 1
                } else {
                    0
                }
            } else if all_lines.len() > count {
                all_lines.len() - count
            } else {
                0
            };
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
        usage = "grep [-ivnclrE] PATTERN [FILE]...",
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
            let mut show_line_numbers = false;
            let mut count_only = false;
            let mut files_only = false;
            let mut recursive = false;
            let mut use_regex = false;
            let mut positional: Vec<String> = Vec::new();

            // Manual parsing to handle combined flags like -rn
            for arg in &remaining {
                if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
                    for c in arg[1..].chars() {
                        match c {
                            'i' => ignore_case = true,
                            'v' => invert = true,
                            'n' => show_line_numbers = true,
                            'c' => count_only = true,
                            'l' => files_only = true,
                            'r' | 'R' => recursive = true,
                            'E' => use_regex = true,
                            _ => {}
                        }
                    }
                } else {
                    positional.push(arg.clone());
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

            // Build regex if -E flag
            let regex = if use_regex {
                let pat = if ignore_case {
                    format!("(?i){}", pattern)
                } else {
                    pattern.clone()
                };
                match regex::Regex::new(&pat) {
                    Ok(re) => Some(re),
                    Err(e) => {
                        let msg = format!("grep: invalid regex: {}\n", e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 2;
                    }
                }
            } else {
                None
            };

            let matches = |line: &str| -> bool {
                let matched = if let Some(ref re) = regex {
                    re.is_match(line)
                } else {
                    let line_check = if ignore_case {
                        line.to_lowercase()
                    } else {
                        line.to_string()
                    };
                    let pat = if ignore_case { &pattern_lower } else { pattern };
                    line_check.contains(pat)
                };
                if invert {
                    !matched
                } else {
                    matched
                }
            };

            // Collect files to search (handle -r recursive)
            let mut search_files: Vec<(String, String)> = Vec::new(); // (display_name, path)
            if recursive && !files.is_empty() {
                for file in &files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };
                    collect_files_recursive(&path, file, &mut search_files);
                }
            } else {
                for file in &files {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };
                    search_files.push((file.clone(), path));
                }
            }

            if search_files.is_empty() && files.is_empty() {
                // Read from stdin
                let reader = BufReader::new(stdin);
                let mut lines_stream = reader.lines();
                let mut match_count = 0usize;
                let mut line_num = 0usize;
                while let Some(Ok(line)) = lines_stream.next().await {
                    line_num += 1;
                    if matches(&line) {
                        match_count += 1;
                        if !count_only {
                            if show_line_numbers {
                                let _ = stdout.write_all(format!("{}:", line_num).as_bytes()).await;
                            }
                            let _ = stdout.write_all(line.as_bytes()).await;
                            let _ = stdout.write_all(b"\n").await;
                        }
                        found = true;
                    }
                }
                if count_only {
                    let _ = stdout
                        .write_all(format!("{}\n", match_count).as_bytes())
                        .await;
                    if match_count > 0 {
                        found = true;
                    }
                }
            } else {
                let show_filename = search_files.len() > 1 || recursive;
                for (display, path) in &search_files {
                    match std::fs::read_to_string(path) {
                        Ok(content) => {
                            let mut match_count = 0usize;
                            let mut file_matched = false;
                            for (line_num, line) in content.lines().enumerate() {
                                if matches(line) {
                                    match_count += 1;
                                    file_matched = true;
                                    found = true;
                                    if files_only {
                                        break;
                                    }
                                    if !count_only {
                                        if show_filename {
                                            let _ = stdout
                                                .write_all(format!("{}:", display).as_bytes())
                                                .await;
                                        }
                                        if show_line_numbers {
                                            let _ = stdout
                                                .write_all(format!("{}:", line_num + 1).as_bytes())
                                                .await;
                                        }
                                        let _ = stdout.write_all(line.as_bytes()).await;
                                        let _ = stdout.write_all(b"\n").await;
                                    }
                                }
                            }
                            if files_only && file_matched {
                                let _ = stdout.write_all(format!("{}\n", display).as_bytes()).await;
                            }
                            if count_only {
                                if show_filename {
                                    let _ = stdout
                                        .write_all(
                                            format!("{}:{}\n", display, match_count).as_bytes(),
                                        )
                                        .await;
                                } else {
                                    let _ = stdout
                                        .write_all(format!("{}\n", match_count).as_bytes())
                                        .await;
                                }
                                if match_count > 0 {
                                    found = true;
                                }
                            }
                        }
                        Err(e) => {
                            let msg = format!("grep: {}: {}\n", display, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                        }
                    }
                }
            }

            if found {
                0
            } else {
                1
            }
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
                (
                    content.lines().count(),
                    content.split_whitespace().count(),
                    content.len(),
                )
            };

            let num_flags = show_lines as usize + show_words as usize + show_chars as usize;
            let format_counts = |l: usize, w: usize, c: usize, name: Option<&str>| -> String {
                let mut parts = Vec::new();
                // Use padding only when showing multiple stats or a filename
                let pad = name.is_some() || num_flags > 1;
                if show_lines {
                    if pad {
                        parts.push(format!("{:8}", l));
                    } else {
                        parts.push(l.to_string());
                    }
                }
                if show_words {
                    if pad {
                        parts.push(format!("{:8}", w));
                    } else {
                        parts.push(w.to_string());
                    }
                }
                if show_chars {
                    if pad {
                        parts.push(format!("{:8}", c));
                    } else {
                        parts.push(c.to_string());
                    }
                }
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
                let _ = stdout
                    .write_all(format_counts(l, w, c, None).as_bytes())
                    .await;
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
                            let _ = stdout
                                .write_all(format_counts(l, w, c, Some(file)).as_bytes())
                                .await;
                        }
                        Err(e) => {
                            let msg = format!("wc: {}: {}\n", file, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                        }
                    }
                }
                if files.len() > 1 {
                    let _ = stdout
                        .write_all(
                            format_counts(total.0, total.1, total.2, Some("total")).as_bytes(),
                        )
                        .await;
                }
            }
            0
        })
    }

    /// sort - sort lines
    #[shell_command(
        name = "sort",
        usage = "sort [-rnuk] [-t SEP] [FILE]",
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
            let mut numeric = false;
            let mut unique = false;
            let mut key_field: Option<usize> = None;
            let mut separator: Option<String> = None;
            let mut files: Vec<String> = Vec::new();

            // Manual parsing because we need to handle -t, -k, and combined flags like -nr
            let mut i = 0;
            while i < remaining.len() {
                let arg = &remaining[i];
                if arg == "-t" && i + 1 < remaining.len() {
                    separator = Some(remaining[i + 1].clone());
                    i += 2;
                } else if arg.starts_with("-t") && arg.len() > 2 {
                    separator = Some(arg[2..].to_string());
                    i += 1;
                } else if arg == "-k" && i + 1 < remaining.len() {
                    // Parse key spec: just take the first number
                    let spec = &remaining[i + 1];
                    key_field = spec
                        .split(|c: char| !c.is_ascii_digit())
                        .next()
                        .and_then(|s| s.parse::<usize>().ok());
                    i += 2;
                } else if arg.starts_with("-k") && arg.len() > 2 {
                    let spec = &arg[2..];
                    key_field = spec
                        .split(|c: char| !c.is_ascii_digit())
                        .next()
                        .and_then(|s| s.parse::<usize>().ok());
                    i += 1;
                } else if arg.starts_with('-') && !arg.starts_with("--") {
                    for c in arg[1..].chars() {
                        match c {
                            'r' => reverse = true,
                            'n' => numeric = true,
                            'u' => unique = true,
                            _ => {}
                        }
                    }
                    i += 1;
                } else {
                    files.push(arg.clone());
                    i += 1;
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

            // Extract sort key from a line
            let extract_key = |line: &str| -> String {
                if let Some(k) = key_field {
                    let sep = separator.as_deref();
                    let parts: Vec<&str> = if let Some(s) = sep {
                        line.split(s).collect()
                    } else {
                        line.split_whitespace().collect()
                    };
                    parts.get(k.saturating_sub(1)).unwrap_or(&"").to_string()
                } else {
                    line.to_string()
                }
            };

            // Extract leading numeric value from a string (like sort -n does)
            let parse_leading_number = |s: &str| -> f64 {
                let s = s.trim_start();
                let mut end = 0;
                let chars: Vec<char> = s.chars().collect();
                // Optional sign
                if end < chars.len() && (chars[end] == '-' || chars[end] == '+') {
                    end += 1;
                }
                let mut has_dot = false;
                while end < chars.len() {
                    if chars[end].is_ascii_digit() {
                        end += 1;
                    } else if chars[end] == '.' && !has_dot {
                        has_dot = true;
                        end += 1;
                    } else {
                        break;
                    }
                }
                if end == 0 || (end == 1 && (chars[0] == '-' || chars[0] == '+')) {
                    return 0.0;
                }
                s[..end].parse().unwrap_or(0.0)
            };

            // Sort using extracted keys
            lines.sort_by(|a, b| {
                let ka = extract_key(a);
                let kb = extract_key(b);
                let cmp = if numeric {
                    let na = parse_leading_number(&ka);
                    let nb = parse_leading_number(&kb);
                    na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal)
                } else {
                    ka.cmp(&kb)
                };
                if reverse {
                    cmp.reverse()
                } else {
                    cmp
                }
            });

            // Deduplicate if -u
            if unique {
                lines.dedup();
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
                            let _ = stdout
                                .write_all(format!("{:7} {}\n", cnt, p).as_bytes())
                                .await;
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
                    let _ = stdout
                        .write_all(format!("{:7} {}\n", cnt, p).as_bytes())
                        .await;
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

    /// sed - stream editor
    #[shell_command(
        name = "sed",
        usage = "sed [-n] SCRIPT [FILE]...",
        description = "Stream editor for text transformation"
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

            // Parse -n flag and script
            let mut quiet = false;
            let mut script_idx = 0;
            for (i, arg) in remaining.iter().enumerate() {
                if arg == "-n" {
                    quiet = true;
                } else {
                    script_idx = i;
                    break;
                }
            }

            if script_idx >= remaining.len()
                || (remaining[script_idx] == "-n" && remaining.len() <= script_idx + 1)
            {
                let _ = stderr.write_all(b"sed: missing script\n").await;
                return 1;
            }

            // Skip -n flags to find the script
            let mut actual_script_idx = 0;
            for (i, arg) in remaining.iter().enumerate() {
                if arg != "-n" {
                    actual_script_idx = i;
                    break;
                }
            }

            let script = &remaining[actual_script_idx];
            let files: Vec<_> = remaining[actual_script_idx + 1..].to_vec();

            // Parse the sed command
            let sed_cmd = parse_sed_command(script);

            // Collect all lines
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
                            let msg = format!("sed: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
                }
            }

            let total = all_lines.len();

            for (idx, line) in all_lines.iter().enumerate() {
                let line_num = idx + 1; // 1-based
                match &sed_cmd {
                    SedCommand::Substitute {
                        pattern,
                        replacement,
                        global,
                        use_regex,
                    } => {
                        let result = if *use_regex {
                            if let Ok(re) = regex::Regex::new(pattern) {
                                if *global {
                                    re.replace_all(line, replacement.as_str()).to_string()
                                } else {
                                    re.replace(line, replacement.as_str()).to_string()
                                }
                            } else if *global {
                                line.replace(pattern, replacement)
                            } else {
                                line.replacen(pattern, replacement, 1)
                            }
                        } else if *global {
                            line.replace(pattern, replacement)
                        } else {
                            line.replacen(pattern, replacement, 1)
                        };
                        if !quiet {
                            let _ = stdout.write_all(result.as_bytes()).await;
                            let _ = stdout.write_all(b"\n").await;
                        }
                    }
                    SedCommand::Delete { addr } => {
                        let should_delete = match addr {
                            SedAddr::Line(n) => line_num == *n,
                            SedAddr::Last => line_num == total,
                            SedAddr::None => true,
                        };
                        if !should_delete && !quiet {
                            let _ = stdout.write_all(line.as_bytes()).await;
                            let _ = stdout.write_all(b"\n").await;
                        }
                    }
                    SedCommand::Print { start, end } => {
                        // -n mode: only print lines in range
                        if line_num >= *start && line_num <= *end {
                            let _ = stdout.write_all(line.as_bytes()).await;
                            let _ = stdout.write_all(b"\n").await;
                        } else if !quiet {
                            let _ = stdout.write_all(line.as_bytes()).await;
                            let _ = stdout.write_all(b"\n").await;
                        }
                    }
                    SedCommand::Unknown => {
                        if !quiet {
                            let _ = stdout.write_all(line.as_bytes()).await;
                            let _ = stdout.write_all(b"\n").await;
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
                let _ = stderr
                    .write_all(b"cut: you must specify a list of fields\n")
                    .await;
                return 1;
            }

            let extract = |line: &str| -> String {
                let parts: Vec<&str> = line.split(delimiter).collect();
                let selected: Vec<&str> = fields
                    .iter()
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
        usage = "tr [-dsc] SET1 [SET2]",
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
            let mut squeeze_mode = false;
            let mut complement_mode = false;
            let mut positional: Vec<String> = Vec::new();

            // Manual parsing to handle combined flags like -cd, -cs
            for arg in &remaining {
                if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
                    for c in arg[1..].chars() {
                        match c {
                            'd' => delete_mode = true,
                            's' => squeeze_mode = true,
                            'c' => complement_mode = true,
                            _ => {}
                        }
                    }
                } else {
                    positional.push(arg.clone());
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

            // Read ALL input as bytes (tr operates on characters, not lines)
            let mut content = String::new();
            let reader = BufReader::new(stdin);
            let mut lines = reader.lines();
            let mut first = true;
            while let Some(Ok(line)) = lines.next().await {
                if !first {
                    content.push('\n');
                }
                content.push_str(&line);
                first = false;
            }
            // The input from echo has a trailing newline
            if !first {
                content.push('\n');
            }

            let in_set = |c: char| -> bool {
                let found = set1.contains(&c);
                if complement_mode {
                    !found
                } else {
                    found
                }
            };

            let mut result = String::new();
            let mut last_char: Option<char> = None;

            for c in content.chars() {
                if in_set(c) {
                    if delete_mode {
                        // Delete this character
                        continue;
                    }
                    // Translate: find position in set1, map to set2
                    let translated = if complement_mode {
                        // For complement mode, all non-set1 chars map to last char of set2
                        set2.last().copied().unwrap_or(c)
                    } else if let Some(pos) = set1.iter().position(|&x| x == c) {
                        if pos < set2.len() {
                            set2[pos]
                        } else if !set2.is_empty() {
                            *set2.last().unwrap()
                        } else {
                            c
                        }
                    } else {
                        c
                    };
                    if squeeze_mode {
                        if last_char == Some(translated) {
                            continue;
                        }
                    }
                    result.push(translated);
                    last_char = Some(translated);
                } else {
                    if squeeze_mode && !delete_mode {
                        last_char = Some(c);
                    }
                    result.push(c);
                }
            }

            let _ = stdout.write_all(result.as_bytes()).await;
            0
        })
    }

    /// comm - compare two sorted files line by line
    #[shell_command(
        name = "comm",
        usage = "comm [-1] [-2] [-3] FILE1 FILE2",
        description = "Compare two sorted files line by line"
    )]
    fn cmd_comm(
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
                if let Some(help) = TextCommands::show_help("comm") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut suppress1 = false;
            let mut suppress2 = false;
            let mut suppress3 = false;
            let mut files: Vec<String> = Vec::new();

            for arg in &remaining {
                match arg.as_str() {
                    "-1" => suppress1 = true,
                    "-2" => suppress2 = true,
                    "-3" => suppress3 = true,
                    "-12" | "-21" => {
                        suppress1 = true;
                        suppress2 = true;
                    }
                    "-13" | "-31" => {
                        suppress1 = true;
                        suppress3 = true;
                    }
                    "-23" | "-32" => {
                        suppress2 = true;
                        suppress3 = true;
                    }
                    "-123" => {
                        suppress1 = true;
                        suppress2 = true;
                        suppress3 = true;
                    }
                    _ => files.push(arg.clone()),
                }
            }

            if files.len() < 2 {
                let _ = stderr.write_all(b"comm: missing operand\n").await;
                return 1;
            }

            let resolve = |f: &str| -> String {
                if f.starts_with('/') {
                    f.to_string()
                } else {
                    format!("{}/{}", cwd, f)
                }
            };

            let lines1: Vec<String> = match std::fs::read_to_string(resolve(&files[0])) {
                Ok(s) => s.lines().map(String::from).collect(),
                Err(e) => {
                    let msg = format!("comm: {}: {}\n", files[0], e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };
            let lines2: Vec<String> = match std::fs::read_to_string(resolve(&files[1])) {
                Ok(s) => s.lines().map(String::from).collect(),
                Err(e) => {
                    let msg = format!("comm: {}: {}\n", files[1], e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };

            let mut i = 0;
            let mut j = 0;
            while i < lines1.len() || j < lines2.len() {
                if i < lines1.len() && j < lines2.len() {
                    match lines1[i].cmp(&lines2[j]) {
                        std::cmp::Ordering::Less => {
                            if !suppress1 {
                                let _ = stdout
                                    .write_all(format!("{}\n", lines1[i]).as_bytes())
                                    .await;
                            }
                            i += 1;
                        }
                        std::cmp::Ordering::Greater => {
                            if !suppress2 {
                                let prefix = if suppress1 { "" } else { "\t" };
                                let _ = stdout
                                    .write_all(format!("{}{}\n", prefix, lines2[j]).as_bytes())
                                    .await;
                            }
                            j += 1;
                        }
                        std::cmp::Ordering::Equal => {
                            if !suppress3 {
                                let prefix = match (suppress1, suppress2) {
                                    (true, true) => "",
                                    (true, false) | (false, true) => "\t",
                                    (false, false) => "\t\t",
                                };
                                let _ = stdout
                                    .write_all(format!("{}{}\n", prefix, lines1[i]).as_bytes())
                                    .await;
                            }
                            i += 1;
                            j += 1;
                        }
                    }
                } else if i < lines1.len() {
                    if !suppress1 {
                        let _ = stdout
                            .write_all(format!("{}\n", lines1[i]).as_bytes())
                            .await;
                    }
                    i += 1;
                } else {
                    if !suppress2 {
                        let prefix = if suppress1 { "" } else { "\t" };
                        let _ = stdout
                            .write_all(format!("{}{}\n", prefix, lines2[j]).as_bytes())
                            .await;
                    }
                    j += 1;
                }
            }
            0
        })
    }

    /// join - join lines of two files on a common field
    #[shell_command(
        name = "join",
        usage = "join [-1 FIELD] [-2 FIELD] [-t CHAR] [-a FILENUM] FILE1 FILE2",
        description = "Join lines of two files on a common field"
    )]
    fn cmd_join(
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
                if let Some(help) = TextCommands::show_help("join") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut field1: usize = 1;
            let mut field2: usize = 1;
            let mut separator: Option<char> = None;
            let mut unpairable: Option<usize> = None; // 1 or 2
            let mut files: Vec<String> = Vec::new();

            let mut i = 0;
            while i < remaining.len() {
                match remaining[i].as_str() {
                    "-1" => {
                        i += 1;
                        if i < remaining.len() {
                            field1 = remaining[i].parse().unwrap_or(1);
                        }
                    }
                    "-2" => {
                        i += 1;
                        if i < remaining.len() {
                            field2 = remaining[i].parse().unwrap_or(1);
                        }
                    }
                    "-t" => {
                        i += 1;
                        if i < remaining.len() {
                            separator = remaining[i].chars().next();
                        }
                    }
                    "-a" => {
                        i += 1;
                        if i < remaining.len() {
                            unpairable = remaining[i].parse().ok();
                        }
                    }
                    s if !s.starts_with('-') => files.push(s.to_string()),
                    _ => {}
                }
                i += 1;
            }

            if files.len() < 2 {
                let _ = stderr.write_all(b"join: missing operand\n").await;
                return 1;
            }

            let resolve = |f: &str| -> String {
                if f.starts_with('/') {
                    f.to_string()
                } else {
                    format!("{}/{}", cwd, f)
                }
            };

            let split_line = |line: &str, sep: Option<char>| -> Vec<String> {
                match sep {
                    Some(c) => line.split(c).map(String::from).collect(),
                    None => line.split_whitespace().map(String::from).collect(),
                }
            };

            let lines1: Vec<String> = match std::fs::read_to_string(resolve(&files[0])) {
                Ok(s) => s.lines().map(String::from).collect(),
                Err(e) => {
                    let msg = format!("join: {}: {}\n", files[0], e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };
            let lines2: Vec<String> = match std::fs::read_to_string(resolve(&files[1])) {
                Ok(s) => s.lines().map(String::from).collect(),
                Err(e) => {
                    let msg = format!("join: {}: {}\n", files[1], e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };

            let sep_str = match separator {
                Some(c) => c.to_string(),
                None => " ".to_string(),
            };

            // Build index for file2: key -> list of lines
            let mut file2_map: std::collections::BTreeMap<String, Vec<Vec<String>>> =
                std::collections::BTreeMap::new();
            let mut file2_matched: Vec<bool> = vec![false; lines2.len()];

            for (idx, line) in lines2.iter().enumerate() {
                let fields = split_line(line, separator);
                if field2 > 0 && field2 <= fields.len() {
                    let key = fields[field2 - 1].clone();
                    file2_map
                        .entry(key)
                        .or_default()
                        .push(vec![idx.to_string()].into_iter().chain(fields).collect());
                }
            }

            for line1 in &lines1 {
                let fields1 = split_line(line1, separator);
                if field1 == 0 || field1 > fields1.len() {
                    continue;
                }
                let key = &fields1[field1 - 1];
                let mut matched = false;

                if let Some(entries) = file2_map.get(key) {
                    for entry in entries {
                        let idx: usize = entry[0].parse().unwrap();
                        file2_matched[idx] = true;
                        let fields2 = &entry[1..]; // skip the idx

                        // Output: key, then other fields from file1, then other fields from file2
                        let mut parts = vec![key.clone()];
                        for (k, f) in fields1.iter().enumerate() {
                            if k != field1 - 1 {
                                parts.push(f.clone());
                            }
                        }
                        for (k, f) in fields2.iter().enumerate() {
                            if k != field2 - 1 {
                                parts.push(f.clone());
                            }
                        }
                        let _ = stdout
                            .write_all(format!("{}\n", parts.join(&sep_str)).as_bytes())
                            .await;
                        matched = true;
                    }
                }

                if !matched && unpairable == Some(1) {
                    let _ = stdout.write_all(format!("{}\n", line1).as_bytes()).await;
                }
            }

            // Print unpairable lines from file2 if requested
            if unpairable == Some(2) {
                for (idx, line) in lines2.iter().enumerate() {
                    if !file2_matched[idx] {
                        let _ = stdout.write_all(format!("{}\n", line).as_bytes()).await;
                    }
                }
            }

            0
        })
    }
}

/// Recursively collect files for grep -r
fn collect_files_recursive(dir: &str, display_base: &str, results: &mut Vec<(String, String)>) {
    let meta = match std::fs::metadata(dir) {
        Ok(m) => m,
        Err(_) => return,
    };
    if meta.is_file() {
        results.push((display_base.to_string(), dir.to_string()));
        return;
    }
    if !meta.is_dir() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut sorted: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        sorted.sort_by_key(|e| e.file_name());
        for entry in sorted {
            let name = entry.file_name().to_string_lossy().to_string();
            let child_path = entry.path().to_string_lossy().to_string();
            let child_display = format!("{}/{}", display_base, name);
            if entry.path().is_dir() {
                collect_files_recursive(&child_path, &child_display, results);
            } else {
                results.push((child_display, child_path));
            }
        }
    }
}

/// Sed address types
enum SedAddr {
    Line(usize),
    Last,
    None,
}

/// Parsed sed command
enum SedCommand {
    Substitute {
        pattern: String,
        replacement: String,
        global: bool,
        use_regex: bool,
    },
    Delete {
        addr: SedAddr,
    },
    Print {
        start: usize,
        end: usize,
    },
    Unknown,
}

/// Parse a sed command (supports s///, Nd, $d, N,Mp)
fn parse_sed_command(script: &str) -> SedCommand {
    let trimmed = script.trim();

    // Handle address + command: "1d", "$d", "2,4p"
    // Range print: N,Mp
    if let Some(comma_pos) = trimmed.find(',') {
        let before = &trimmed[..comma_pos];
        let after = &trimmed[comma_pos + 1..];
        if after.ends_with('p') {
            let start: usize = before.parse().unwrap_or(1);
            let end_str = &after[..after.len() - 1];
            let end: usize = end_str.parse().unwrap_or(usize::MAX);
            return SedCommand::Print { start, end };
        }
    }

    // Delete command: Nd or $d
    if trimmed.ends_with('d') {
        let addr_str = &trimmed[..trimmed.len() - 1];
        let addr = if addr_str == "$" {
            SedAddr::Last
        } else if let Ok(n) = addr_str.parse::<usize>() {
            SedAddr::Line(n)
        } else {
            SedAddr::None
        };
        return SedCommand::Delete { addr };
    }

    // Substitution: s/pattern/replacement/flags
    if trimmed.starts_with('s') && trimmed.len() >= 4 {
        let delim = trimmed.chars().nth(1).unwrap();
        let rest = &trimmed[2..];
        // Split by delimiter, handling escaped delimiters
        let parts = split_sed_parts(rest, delim);
        if parts.len() >= 2 {
            let raw_pattern = parts[0].clone();
            let replacement = parts[1].clone();
            let flags = parts.get(2).map(|s| s.as_str()).unwrap_or("");
            let global = flags.contains('g');
            // Check if pattern contains regex metacharacters
            let use_regex = raw_pattern.contains('[')
                || raw_pattern.contains('\\')
                || raw_pattern.contains('+')
                || raw_pattern.contains('*')
                || raw_pattern.contains('(')
                || raw_pattern.contains('.')
                || raw_pattern.contains('^')
                || raw_pattern.contains('$');
            // Convert BRE (Basic Regular Expression) to ERE for regex crate:
            // BRE uses \+, \?, \{, \}, \(, \) while ERE uses +, ?, {, }, (, )
            let pattern = if use_regex {
                raw_pattern
                    .replace("\\+", "+")
                    .replace("\\?", "?")
                    .replace("\\(", "(")
                    .replace("\\)", ")")
                    .replace("\\{", "{")
                    .replace("\\}", "}")
            } else {
                raw_pattern
            };
            return SedCommand::Substitute {
                pattern,
                replacement,
                global,
                use_regex,
            };
        }
    }

    SedCommand::Unknown
}

/// Split sed s command parts by delimiter, handling escapes
fn split_sed_parts(s: &str, delim: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for c in s.chars() {
        if escaped {
            current.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
            current.push(c);
        } else if c == delim {
            parts.push(current.clone());
            current.clear();
        } else {
            current.push(c);
        }
    }
    parts.push(current);
    parts
}

/// Legacy parse for unit tests
#[cfg(test)]
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
                if let (Ok(start), Ok(end)) = (range[0].parse::<usize>(), range[1].parse::<usize>())
                {
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
/// Also handles escape sequences: \n, \t, \r, \\
fn expand_char_set(s: &str) -> Vec<char> {
    let mut result = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        // Handle escape sequences
        if chars[i] == '\\' && i + 1 < chars.len() {
            let escaped = match chars[i + 1] {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                '\\' => '\\',
                'a' => '\x07', // bell
                'b' => '\x08', // backspace
                'f' => '\x0C', // form feed
                'v' => '\x0B', // vertical tab
                other => other,
            };
            result.push(escaped);
            i += 2;
        } else if i + 2 < chars.len() && chars[i + 1] == '-' {
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
        assert_eq!(
            expand_char_set("0-9"),
            vec!['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
        );
    }

    #[test]
    fn test_expand_char_set_mixed() {
        assert_eq!(expand_char_set("a-cx"), vec!['a', 'b', 'c', 'x']);
    }
}
