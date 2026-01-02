//! File manipulation commands: ls, cat, touch, mkdir, rmdir, rm, mv, cp

use crate::bindings::wasi::cli::terminal_stdout::get_terminal_stdout;
use futures_lite::io::AsyncWriteExt;
use lexopt::prelude::*;
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::{make_parser, parse_common};

/// File manipulation commands.
pub struct FileCommands;

#[shell_commands]
impl FileCommands {
    /// ls - list directory
    #[shell_command(
        name = "ls",
        usage = "ls [-lahrtSdRF1] [--color=auto|always|never] [PATH]...",
        description = "List directory contents"
    )]
    fn cmd_ls(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd_str = env.cwd.to_string_lossy().to_string();
        let no_color = env.get_var("NO_COLOR").is_some();

        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = FileCommands::show_help("ls") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            // Parse flags
            let mut long_format = false;
            let mut show_all = false;
            let mut human_readable = false;
            let mut sort_by_time = false;
            let mut sort_by_size = false;
            let mut reverse_sort = false;
            let mut _one_per_line = false;
            let mut dir_only = false;
            let mut recursive = false;
            let mut classify = false;
            let mut color_mode = ColorMode::Auto;
            let mut paths: Vec<String> = Vec::new();

            // Manual parsing to handle --color=value
            let mut i = 0;
            while i < remaining.len() {
                let arg = &remaining[i];
                if arg.starts_with("--color") {
                    if arg == "--color" || arg == "--color=auto" {
                        color_mode = ColorMode::Auto;
                    } else if arg == "--color=always" {
                        color_mode = ColorMode::Always;
                    } else if arg == "--color=never" {
                        color_mode = ColorMode::Never;
                    }
                    i += 1;
                    continue;
                }
                i += 1;
            }

            // Use lexopt for short flags
            let mut parser = make_parser(remaining.clone());
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('l') => long_format = true,
                    Short('a') => show_all = true,
                    Short('h') => human_readable = true,
                    Short('t') => sort_by_time = true,
                    Short('S') => sort_by_size = true,
                    Short('r') => reverse_sort = true,
                    Short('1') => _one_per_line = true,
                    Short('d') => dir_only = true,
                    Short('R') => recursive = true,
                    Short('F') => classify = true,
                    Long(_) => {} // Already handled above
                    Value(val) => paths.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            // Determine if we should use color using WASI isatty equivalent
            // get_terminal_stdout() returns Some(_) if stdout is a TTY, None otherwise
            let is_tty = get_terminal_stdout().is_some();
            let use_color = match color_mode {
                ColorMode::Always => true,
                ColorMode::Never => false,
                ColorMode::Auto => !no_color && is_tty,
            };

            if paths.is_empty() {
                let path = if cwd_str == "." || cwd_str.is_empty() {
                    "/".to_string()
                } else {
                    cwd_str.clone()
                };
                paths.push(path);
            }

            for path in paths {
                let resolved = if path.starts_with('/') {
                    path.clone()
                } else if cwd_str == "." || cwd_str.is_empty() {
                    format!("/{}", path)
                } else {
                    format!("{}/{}", cwd_str, path)
                };

                // Handle -d flag: list directory itself, not its contents
                if dir_only {
                    match std::fs::metadata(&resolved) {
                        Ok(meta) => {
                            let name = std::path::Path::new(&resolved)
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_else(|| resolved.clone());
                            let line = format_entry(
                                &name,
                                &meta,
                                long_format,
                                human_readable,
                                use_color,
                                classify,
                            );
                            let _ = stdout.write_all(line.as_bytes()).await;
                        }
                        Err(e) => {
                            let msg = format!("ls: {}: {}\n", resolved, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
                    continue;
                }

                // Handle recursive listing
                if recursive {
                    if let Err(code) = list_recursive(
                        &resolved,
                        show_all,
                        long_format,
                        human_readable,
                        use_color,
                        classify,
                        sort_by_time,
                        sort_by_size,
                        reverse_sort,
                        &mut stdout,
                        &mut stderr,
                    )
                    .await
                    {
                        return code;
                    }
                    continue;
                }

                match std::fs::read_dir(&resolved) {
                    Ok(entries) => {
                        let mut items: Vec<(String, std::fs::Metadata)> = entries
                            .filter_map(|e| e.ok())
                            .filter_map(|e| {
                                let name = e.file_name().to_string_lossy().to_string();
                                if !show_all && name.starts_with('.') {
                                    return None;
                                }
                                e.metadata().ok().map(|m| (name, m))
                            })
                            .collect();

                        // Sort items
                        sort_entries(&mut items, sort_by_time, sort_by_size, reverse_sort);

                        for (name, meta) in items {
                            let line = format_entry(
                                &name,
                                &meta,
                                long_format,
                                human_readable,
                                use_color,
                                classify,
                            );
                            let _ = stdout.write_all(line.as_bytes()).await;
                        }
                    }
                    Err(e) => {
                        let msg = format!("ls: {}: {}\n", resolved, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                }
            }
            0
        })
    }

    /// cat - concatenate and display files
    #[shell_command(
        name = "cat",
        usage = "cat [FILE]...",
        description = "Concatenate files to standard output"
    )]
    fn cmd_cat(
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
                if let Some(help) = FileCommands::show_help("cat") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            if remaining.is_empty() {
                let mut buf = [0u8; 4096];
                let mut reader = stdin;
                loop {
                    match futures_lite::io::AsyncReadExt::read(&mut reader, &mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            if stdout.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            } else {
                for arg in &remaining {
                    let path = if arg.starts_with('/') {
                        arg.clone()
                    } else {
                        format!("{}/{}", cwd, arg)
                    };

                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            if stdout.write_all(content.as_bytes()).await.is_err() {
                                return 1;
                            }
                        }
                        Err(e) => {
                            let msg = format!("cat: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
                }
            }
            0
        })
    }

    /// touch - create empty file or update timestamps
    #[shell_command(
        name = "touch",
        usage = "touch FILE...",
        description = "Create empty files or update timestamps"
    )]
    fn cmd_touch(
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
                if let Some(help) = FileCommands::show_help("touch") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            if remaining.is_empty() {
                let _ = stderr.write_all(b"touch: missing file operand\n").await;
                return 1;
            }

            let mut exit_code = 0;
            for arg in &remaining {
                let path = if arg.starts_with('/') {
                    arg.clone()
                } else {
                    format!("{}/{}", cwd, arg)
                };

                if let Err(e) = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .open(&path)
                {
                    let msg = format!("touch: {}: {}\n", path, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    exit_code = 1;
                }
            }
            exit_code
        })
    }

    /// mkdir - create directories
    #[shell_command(
        name = "mkdir",
        usage = "mkdir [-p] DIR...",
        description = "Create directories"
    )]
    fn cmd_mkdir(
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
                if let Some(help) = FileCommands::show_help("mkdir") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut parents = false;
            let mut dirs: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('p') => parents = true,
                    Value(val) => dirs.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            if dirs.is_empty() {
                let _ = stderr.write_all(b"mkdir: missing operand\n").await;
                return 1;
            }

            let mut exit_code = 0;
            for dir in dirs {
                let path = if dir.starts_with('/') {
                    dir.clone()
                } else {
                    format!("{}/{}", cwd, dir)
                };

                let result = if parents {
                    std::fs::create_dir_all(&path)
                } else {
                    std::fs::create_dir(&path)
                };

                if let Err(e) = result {
                    let msg = format!("mkdir: {}: {}\n", path, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    exit_code = 1;
                }
            }
            exit_code
        })
    }

    /// rmdir - remove empty directories
    #[shell_command(
        name = "rmdir",
        usage = "rmdir DIR...",
        description = "Remove empty directories"
    )]
    fn cmd_rmdir(
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
                if let Some(help) = FileCommands::show_help("rmdir") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            if remaining.is_empty() {
                let _ = stderr.write_all(b"rmdir: missing operand\n").await;
                return 1;
            }

            let mut exit_code = 0;
            for dir in &remaining {
                let path = if dir.starts_with('/') {
                    dir.clone()
                } else {
                    format!("{}/{}", cwd, dir)
                };

                if let Err(e) = std::fs::remove_dir(&path) {
                    let msg = format!("rmdir: {}: {}\n", path, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    exit_code = 1;
                }
            }
            exit_code
        })
    }

    /// rm - remove files or directories
    #[shell_command(
        name = "rm",
        usage = "rm [-rf] FILE...",
        description = "Remove files or directories"
    )]
    fn cmd_rm(
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
                if let Some(help) = FileCommands::show_help("rm") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut recursive = false;
            let mut force = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('r') | Short('R') => recursive = true,
                    Short('f') => force = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            if files.is_empty() {
                eprintln!("[debug] rm: no files after parsing, force={}", force);
                if !force {
                    let _ = stderr.write_all(b"rm: missing operand\n").await;
                }
                return if force { 0 } else { 1 };
            }

            let mut exit_code = 0;
            for file in files {
                let path = if file.starts_with('/') {
                    file.clone()
                } else {
                    format!("{}/{}", cwd, file)
                };

                let metadata = match std::fs::metadata(&path) {
                    Ok(m) => m,
                    Err(e) => {
                        if !force {
                            let msg = format!("rm: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            exit_code = 1;
                        }
                        continue;
                    }
                };

                let result = if metadata.is_dir() {
                    if recursive {
                        std::fs::remove_dir_all(&path)
                    } else {
                        let msg = format!("rm: {}: is a directory\n", path);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        exit_code = 1;
                        continue;
                    }
                } else {
                    std::fs::remove_file(&path)
                };

                if let Err(e) = result {
                    if !force {
                        let msg = format!("rm: {}: {}\n", path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        exit_code = 1;
                    }
                }
            }
            exit_code
        })
    }

    /// mv - move files
    #[shell_command(
        name = "mv",
        usage = "mv SOURCE DEST",
        description = "Move or rename files"
    )]
    fn cmd_mv(
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
                if let Some(help) = FileCommands::show_help("mv") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            if remaining.len() < 2 {
                let _ = stderr.write_all(b"mv: missing destination operand\n").await;
                return 1;
            }

            let resolve = |p: &str| -> String {
                if p.starts_with('/') {
                    p.to_string()
                } else {
                    format!("{}/{}", cwd, p)
                }
            };

            let src = resolve(&remaining[0]);
            let dst = resolve(&remaining[1]);

            if let Err(e) = std::fs::rename(&src, &dst) {
                let msg = format!("mv: {}: {}\n", src, e);
                let _ = stderr.write_all(msg.as_bytes()).await;
                return 1;
            }
            0
        })
    }

    /// cp - copy files
    #[shell_command(
        name = "cp",
        usage = "cp [-r] SOURCE DEST",
        description = "Copy files and directories"
    )]
    fn cmd_cp(
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
                if let Some(help) = FileCommands::show_help("cp") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut recursive = false;
            let mut paths: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('r') | Short('R') => recursive = true,
                    Value(val) => paths.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            if paths.len() < 2 {
                let _ = stderr.write_all(b"cp: missing destination operand\n").await;
                return 1;
            }

            let resolve = |p: &str| -> String {
                if p.starts_with('/') {
                    p.to_string()
                } else {
                    format!("{}/{}", cwd, p)
                }
            };

            let src = resolve(&paths[0]);
            let dst = resolve(&paths[1]);

            let metadata = match std::fs::metadata(&src) {
                Ok(m) => m,
                Err(e) => {
                    let msg = format!("cp: {}: {}\n", src, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };

            if metadata.is_dir() {
                if !recursive {
                    let msg = format!("cp: {}: is a directory (use -r)\n", src);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
                if let Err(e) = super::copy_dir_recursive(&src, &dst) {
                    let msg = format!("cp: {}\n", e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            } else if let Err(e) = std::fs::copy(&src, &dst) {
                let msg = format!("cp: {}: {}\n", src, e);
                let _ = stderr.write_all(msg.as_bytes()).await;
                return 1;
            }
            0
        })
    }

    /// find - search for files
    #[shell_command(
        name = "find",
        usage = "find [PATH] [-name PATTERN] [-type f|d]",
        description = "Search for files in a directory hierarchy"
    )]
    fn cmd_find(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = FileCommands::show_help("find") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut search_path = "/".to_string();
            let mut name_pattern: Option<String> = None;
            let mut type_filter: Option<char> = None;
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Long("name") | Short('n') => {
                        if let Ok(val) = parser.value() {
                            name_pattern = Some(val.string().unwrap_or_default());
                        }
                    }
                    Long("type") | Short('t') => {
                        if let Ok(val) = parser.value() {
                            let s = val.string().unwrap_or_default();
                            type_filter = s.chars().next();
                        }
                    }
                    Value(val) => {
                        let path = val.string().unwrap_or_default();
                        search_path = if path.starts_with('/') {
                            path
                        } else {
                            format!("{}/{}", cwd, path)
                        };
                    }
                    _ => {}
                }
            }

            fn find_recursive(
                dir: &str,
                pattern: &Option<String>,
                type_filter: Option<char>,
                results: &mut Vec<String>,
            ) {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let path = entry.path();
                        let path_str = path.to_string_lossy().to_string();
                        let file_name = entry.file_name().to_string_lossy().to_string();
                        let is_dir = path.is_dir();

                        // Check type filter
                        let type_ok = match type_filter {
                            Some('f') => !is_dir,
                            Some('d') => is_dir,
                            _ => true,
                        };

                        // Check name pattern (glob-like)
                        let name_ok = match pattern {
                            Some(pat) => glob_match(pat, &file_name),
                            None => true,
                        };

                        if type_ok && name_ok {
                            results.push(path_str.clone());
                        }

                        if is_dir {
                            find_recursive(&path_str, pattern, type_filter, results);
                        }
                    }
                }
            }

            let mut results = Vec::new();
            find_recursive(&search_path, &name_pattern, type_filter, &mut results);
            results.sort();

            for path in results {
                let _ = stdout.write_all(path.as_bytes()).await;
                let _ = stdout.write_all(b"\n").await;
            }
            0
        })
    }

    /// diff - compare files line by line
    #[shell_command(
        name = "diff",
        usage = "diff [-u] FILE1 FILE2",
        description = "Compare files line by line"
    )]
    fn cmd_diff(
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
                if let Some(help) = FileCommands::show_help("diff") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut unified = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('u') => unified = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            if files.len() < 2 {
                let _ = stderr.write_all(b"diff: need two files to compare\n").await;
                return 1;
            }

            let resolve = |p: &str| -> String {
                if p.starts_with('/') {
                    p.to_string()
                } else {
                    format!("{}/{}", cwd, p)
                }
            };

            let path1 = resolve(&files[0]);
            let path2 = resolve(&files[1]);

            let content1 = match std::fs::read_to_string(&path1) {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!("diff: {}: {}\n", path1, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };

            let content2 = match std::fs::read_to_string(&path2) {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!("diff: {}: {}\n", path2, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };

            let lines1: Vec<&str> = content1.lines().collect();
            let lines2: Vec<&str> = content2.lines().collect();

            let mut has_diff = false;

            if unified {
                let _ = stdout
                    .write_all(format!("--- {}\n", files[0]).as_bytes())
                    .await;
                let _ = stdout
                    .write_all(format!("+++ {}\n", files[1]).as_bytes())
                    .await;
            }

            // Simple line-by-line diff
            let max_lines = std::cmp::max(lines1.len(), lines2.len());
            for i in 0..max_lines {
                let l1 = lines1.get(i);
                let l2 = lines2.get(i);

                match (l1, l2) {
                    (Some(a), Some(b)) if a != b => {
                        has_diff = true;
                        if unified {
                            let _ = stdout.write_all(format!("-{}\n", a).as_bytes()).await;
                            let _ = stdout.write_all(format!("+{}\n", b).as_bytes()).await;
                        } else {
                            let _ = stdout
                                .write_all(format!("{}c{}\n", i + 1, i + 1).as_bytes())
                                .await;
                            let _ = stdout.write_all(format!("< {}\n", a).as_bytes()).await;
                            let _ = stdout.write_all(b"---\n").await;
                            let _ = stdout.write_all(format!("> {}\n", b).as_bytes()).await;
                        }
                    }
                    (Some(a), None) => {
                        has_diff = true;
                        if unified {
                            let _ = stdout.write_all(format!("-{}\n", a).as_bytes()).await;
                        } else {
                            let _ = stdout.write_all(format!("{}d\n", i + 1).as_bytes()).await;
                            let _ = stdout.write_all(format!("< {}\n", a).as_bytes()).await;
                        }
                    }
                    (None, Some(b)) => {
                        has_diff = true;
                        if unified {
                            let _ = stdout.write_all(format!("+{}\n", b).as_bytes()).await;
                        } else {
                            let _ = stdout.write_all(format!("{}a\n", i + 1).as_bytes()).await;
                            let _ = stdout.write_all(format!("> {}\n", b).as_bytes()).await;
                        }
                    }
                    _ => {
                        if unified {
                            if let Some(line) = l1 {
                                let _ = stdout.write_all(format!(" {}\n", line).as_bytes()).await;
                            }
                        }
                    }
                }
            }

            if has_diff {
                1
            } else {
                0
            }
        })
    }

    /// file - determine file type
    #[shell_command(
        name = "file",
        usage = "file FILE...",
        description = "Determine file type"
    )]
    fn cmd_file(
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
                if let Some(help) = FileCommands::show_help("file") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            if remaining.is_empty() {
                let _ = stderr.write_all(b"file: missing operand\n").await;
                return 1;
            }

            for file in &remaining {
                let path = if file.starts_with('/') {
                    file.clone()
                } else {
                    format!("{}/{}", cwd, file)
                };

                let file_type = detect_file_type(&path);
                let _ = stdout
                    .write_all(format!("{}: {}\n", file, file_type).as_bytes())
                    .await;
            }

            0
        })
    }

    /// realpath - resolve canonical path
    #[shell_command(
        name = "realpath",
        usage = "realpath PATH...",
        description = "Print resolved absolute path"
    )]
    fn cmd_realpath(
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
                if let Some(help) = FileCommands::show_help("realpath") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            if remaining.is_empty() {
                let _ = stderr.write_all(b"realpath: missing operand\n").await;
                return 1;
            }

            let mut exit_code = 0;
            for path in &remaining {
                let resolved = resolve_canonical_path(&cwd, path);
                if std::fs::metadata(&resolved).is_ok() {
                    let _ = stdout.write_all(format!("{}\n", resolved).as_bytes()).await;
                } else {
                    let _ = stderr
                        .write_all(
                            format!("realpath: {}: No such file or directory\n", path).as_bytes(),
                        )
                        .await;
                    exit_code = 1;
                }
            }

            exit_code
        })
    }

    /// du - disk usage
    #[shell_command(
        name = "du",
        usage = "du [-s] [-h] [PATH...]",
        description = "Estimate file space usage"
    )]
    fn cmd_du(
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
                if let Some(help) = FileCommands::show_help("du") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut summary_only = false;
            let mut human_readable = false;
            let mut paths: Vec<String> = Vec::new();

            for arg in &remaining {
                match arg.as_str() {
                    "-s" => summary_only = true,
                    "-h" => human_readable = true,
                    "-sh" | "-hs" => {
                        summary_only = true;
                        human_readable = true;
                    }
                    _ => paths.push(arg.clone()),
                }
            }

            if paths.is_empty() {
                paths.push(".".to_string());
            }

            for path in &paths {
                let full_path = if path.starts_with('/') {
                    path.clone()
                } else {
                    format!("{}/{}", cwd, path)
                };

                match calculate_disk_usage(&full_path, summary_only, human_readable, &mut stdout)
                    .await
                {
                    Ok(_) => {}
                    Err(e) => {
                        let _ = stderr
                            .write_all(format!("du: {}: {}\n", path, e).as_bytes())
                            .await;
                    }
                }
            }

            0
        })
    }

    /// readlink - print symlink target
    #[shell_command(
        name = "readlink",
        usage = "readlink [-f] LINK...",
        description = "Print symbolic link target"
    )]
    fn cmd_readlink(
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
                if let Some(help) = FileCommands::show_help("readlink") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut canonicalize = false;
            let mut files: Vec<String> = Vec::new();

            for arg in &remaining {
                if arg == "-f" {
                    canonicalize = true;
                } else {
                    files.push(arg.clone());
                }
            }

            if files.is_empty() {
                let _ = stderr.write_all(b"readlink: missing operand\n").await;
                return 1;
            }

            for file in &files {
                let path = if file.starts_with('/') {
                    file.clone()
                } else {
                    format!("{}/{}", cwd, file)
                };

                if canonicalize {
                    // Return canonical path
                    let resolved = resolve_canonical_path(&cwd, file);
                    let _ = stdout.write_all(format!("{}\n", resolved).as_bytes()).await;
                } else {
                    // Read symlink target
                    match std::fs::read_link(&path) {
                        Ok(target) => {
                            let _ = stdout
                                .write_all(format!("{}\n", target.display()).as_bytes())
                                .await;
                        }
                        Err(_) => {
                            // Not a symlink - print nothing (like GNU readlink)
                        }
                    }
                }
            }

            0
        })
    }
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

/// Detect file type by examining magic bytes and metadata
fn detect_file_type(path: &str) -> String {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return "cannot open (No such file or directory)".to_string(),
    };

    if metadata.is_dir() {
        return "directory".to_string();
    }

    if metadata.is_symlink() {
        return "symbolic link".to_string();
    }

    // Try to read magic bytes
    if let Ok(data) = std::fs::read(path) {
        if data.is_empty() {
            return "empty".to_string();
        }

        // Check magic signatures
        if data.starts_with(b"\x89PNG\r\n\x1a\n") {
            return "PNG image data".to_string();
        }
        if data.starts_with(b"\xff\xd8\xff") {
            return "JPEG image data".to_string();
        }
        if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
            return "GIF image data".to_string();
        }
        if data.starts_with(b"RIFF") && data.len() > 8 && &data[8..12] == b"WEBP" {
            return "WebP image data".to_string();
        }
        if data.starts_with(b"%PDF") {
            return "PDF document".to_string();
        }
        if data.starts_with(b"PK\x03\x04") {
            // Could be ZIP, DOCX, XLSX, JAR, etc.
            return "Zip archive data".to_string();
        }
        if data.starts_with(b"\x1f\x8b") {
            return "gzip compressed data".to_string();
        }
        if data.len() > 262 && &data[257..262] == b"ustar" {
            return "POSIX tar archive".to_string();
        }
        if data.starts_with(b"{\n") || data.starts_with(b"{\r\n") || data.starts_with(b"{\"") {
            return "JSON data".to_string();
        }
        if data.starts_with(b"<!DOCTYPE html")
            || data.starts_with(b"<!doctype html")
            || data.starts_with(b"<html")
        {
            return "HTML document".to_string();
        }
        if data.starts_with(b"<?xml") {
            return "XML document".to_string();
        }
        if data.starts_with(b"#!/") || data.starts_with(b"#!") {
            // Script
            let first_line = data.split(|&b| b == b'\n').next().unwrap_or(&[]);
            let line_str = String::from_utf8_lossy(first_line);
            if line_str.contains("python") {
                return "Python script, ASCII text executable".to_string();
            }
            if line_str.contains("node") || line_str.contains("deno") || line_str.contains("bun") {
                return "JavaScript/TypeScript script, ASCII text executable".to_string();
            }
            if line_str.contains("bash") || line_str.contains("sh") {
                return "Bourne-Again shell script, ASCII text executable".to_string();
            }
            return "script, ASCII text executable".to_string();
        }
        if data.starts_with(b"\x00asm") {
            return "WebAssembly binary".to_string();
        }
        if data.starts_with(b"\x7fELF") {
            return "ELF executable".to_string();
        }
        if data.starts_with(b"\xca\xfe\xba\xbe") || data.starts_with(b"\xcf\xfa\xed\xfe") {
            return "Mach-O executable".to_string();
        }

        // Check if it's text
        let sample = &data[..data.len().min(8192)];
        let is_text = sample.iter().all(|&b| {
            b == b'\n' || b == b'\r' || b == b'\t' || (b >= 0x20 && b < 0x7f) || b >= 0x80
        });

        if is_text {
            // Try to determine text type
            let text = String::from_utf8_lossy(sample);
            if text.contains("function")
                && (text.contains("const ") || text.contains("let ") || text.contains("var "))
            {
                return "JavaScript source, ASCII text".to_string();
            }
            if text.contains("fn ") && text.contains("let ") && text.contains("->") {
                return "Rust source, ASCII text".to_string();
            }
            if text.contains("def ") && text.contains(":") && text.contains("import ") {
                return "Python source, ASCII text".to_string();
            }
            return "ASCII text".to_string();
        }

        return "data".to_string();
    }

    "cannot determine".to_string()
}

/// Resolve a path to its canonical form
fn resolve_canonical_path(cwd: &str, path: &str) -> String {
    let abs_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{}/{}", cwd, path)
    };

    // Normalize the path
    let mut parts: Vec<&str> = Vec::new();
    for part in abs_path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }

    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

/// Calculate disk usage recursively
async fn calculate_disk_usage(
    path: &str,
    summary_only: bool,
    human_readable: bool,
    stdout: &mut piper::Writer,
) -> Result<u64, String> {
    use futures_lite::io::AsyncWriteExt;

    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;

    if metadata.is_file() {
        let size = metadata.len();
        if !summary_only {
            let display = format_size(size, human_readable);
            let _ = stdout
                .write_all(format!("{}\t{}\n", display, path).as_bytes())
                .await;
        }
        return Ok(size);
    }

    if !metadata.is_dir() {
        return Ok(0);
    }

    let mut total: u64 = 0;

    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let entry_str = entry_path.to_string_lossy().to_string();

        // Recursive call using Box::pin for async recursion
        total += Box::pin(calculate_disk_usage(
            &entry_str,
            true, // Always summarize children
            human_readable,
            stdout,
        ))
        .await?;
    }

    if !summary_only {
        let display = format_size(total, human_readable);
        let _ = stdout
            .write_all(format!("{}\t{}\n", display, path).as_bytes())
            .await;
    }

    Ok(total)
}

/// Format size for display
fn format_size(bytes: u64, human_readable: bool) -> String {
    if !human_readable {
        // Return size in 1K blocks
        return ((bytes + 1023) / 1024).to_string();
    }

    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;

    if bytes >= GB {
        format!("{:.1}G", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1}M", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1}K", bytes as f64 / KB as f64)
    } else {
        format!("{}B", bytes)
    }
}

// =============================================================================
// ls command helpers
// =============================================================================

/// Color mode for ls output
#[derive(Debug, Clone, Copy, PartialEq)]
enum ColorMode {
    Auto,
    Always,
    Never,
}

// ANSI color codes
const COLOR_RESET: &str = "\x1b[0m";
const COLOR_DIR: &str = "\x1b[1;34m"; // Bold blue
const COLOR_SYMLINK: &str = "\x1b[36m"; // Cyan
#[allow(dead_code)] // Reserved for executable file highlighting
const COLOR_EXEC: &str = "\x1b[1;32m"; // Bold green

/// Format a single ls entry with optional color and classification
fn format_entry(
    name: &str,
    meta: &std::fs::Metadata,
    long_format: bool,
    human_readable: bool,
    use_color: bool,
    classify: bool,
) -> String {
    let is_dir = meta.is_dir();
    let is_symlink = meta.file_type().is_symlink();

    // Build the name with color and classifier
    let colored_name = if use_color {
        if is_dir {
            format!("{}{}{}", COLOR_DIR, name, COLOR_RESET)
        } else if is_symlink {
            format!("{}{}{}", COLOR_SYMLINK, name, COLOR_RESET)
        } else {
            name.to_string()
        }
    } else {
        name.to_string()
    };

    // Add classifier suffix
    let suffix = if classify {
        if is_dir {
            "/"
        } else if is_symlink {
            "@"
        } else {
            ""
        }
    } else {
        ""
    };

    if long_format {
        let size = meta.len();
        let size_str = if human_readable {
            format_size(size, true)
        } else {
            format!("{:>8}", size)
        };
        let type_char = if is_dir {
            "d"
        } else if is_symlink {
            "l"
        } else {
            "-"
        };
        format!("{} {}  {}{}\n", type_char, size_str, colored_name, suffix)
    } else {
        if is_dir && !classify && !use_color {
            // Traditional ls shows trailing / for directories in non-color mode
            format!("{}/\n", name)
        } else {
            format!("{}{}\n", colored_name, suffix)
        }
    }
}

/// Sort entries by the specified criteria
fn sort_entries(
    items: &mut Vec<(String, std::fs::Metadata)>,
    sort_by_time: bool,
    sort_by_size: bool,
    reverse: bool,
) {
    if sort_by_time {
        items.sort_by(|a, b| {
            let time_a = a.1.modified().ok();
            let time_b = b.1.modified().ok();
            let cmp = time_b.cmp(&time_a); // Newest first
            if reverse {
                cmp.reverse()
            } else {
                cmp
            }
        });
    } else if sort_by_size {
        items.sort_by(|a, b| {
            let cmp = b.1.len().cmp(&a.1.len()); // Largest first
            if reverse {
                cmp.reverse()
            } else {
                cmp
            }
        });
    } else {
        // Default: alphabetical
        items.sort_by(|a, b| {
            let cmp = a.0.cmp(&b.0);
            if reverse {
                cmp.reverse()
            } else {
                cmp
            }
        });
    }
}

/// List directory recursively (ls -R)
async fn list_recursive(
    path: &str,
    show_all: bool,
    long_format: bool,
    human_readable: bool,
    use_color: bool,
    classify: bool,
    sort_by_time: bool,
    sort_by_size: bool,
    reverse_sort: bool,
    stdout: &mut piper::Writer,
    stderr: &mut piper::Writer,
) -> Result<(), i32> {
    use futures_lite::io::AsyncWriteExt;

    // Print directory header
    let header = format!("{}:\n", path);
    let _ = stdout.write_all(header.as_bytes()).await;

    match std::fs::read_dir(path) {
        Ok(entries) => {
            let mut items: Vec<(String, std::fs::Metadata)> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if !show_all && name.starts_with('.') {
                        return None;
                    }
                    e.metadata().ok().map(|m| (name, m))
                })
                .collect();

            sort_entries(&mut items, sort_by_time, sort_by_size, reverse_sort);

            // Collect subdirectories for recursive listing
            let mut subdirs: Vec<String> = Vec::new();

            for (name, meta) in &items {
                let line =
                    format_entry(name, meta, long_format, human_readable, use_color, classify);
                let _ = stdout.write_all(line.as_bytes()).await;

                if meta.is_dir() {
                    subdirs.push(format!("{}/{}", path, name));
                }
            }

            // Add blank line between directory listings
            let _ = stdout.write_all(b"\n").await;

            // Recurse into subdirectories
            for subdir in subdirs {
                Box::pin(list_recursive(
                    &subdir,
                    show_all,
                    long_format,
                    human_readable,
                    use_color,
                    classify,
                    sort_by_time,
                    sort_by_size,
                    reverse_sort,
                    stdout,
                    stderr,
                ))
                .await?;
            }

            Ok(())
        }
        Err(e) => {
            let msg = format!("ls: {}: {}\n", path, e);
            let _ = stderr.write_all(msg.as_bytes()).await;
            Err(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glob_exact() {
        assert!(glob_match("foo", "foo"));
        assert!(!glob_match("foo", "bar"));
        assert!(!glob_match("foo", "foobar"));
    }

    #[test]
    fn test_glob_star_suffix() {
        assert!(glob_match("*.txt", "file.txt"));
        assert!(glob_match("*.txt", ".txt"));
        assert!(!glob_match("*.txt", "file.rs"));
    }

    #[test]
    fn test_glob_star_prefix() {
        assert!(glob_match("test*", "test"));
        assert!(glob_match("test*", "test.txt"));
        assert!(glob_match("test*", "testing"));
    }

    #[test]
    fn test_glob_star_middle() {
        assert!(glob_match("a*c", "ac"));
        assert!(glob_match("a*c", "abc"));
        assert!(glob_match("a*c", "abbc"));
        assert!(!glob_match("a*c", "ab"));
    }

    #[test]
    fn test_glob_question() {
        assert!(glob_match("a?c", "abc"));
        assert!(glob_match("a?c", "aXc"));
        assert!(!glob_match("a?c", "ac"));
        assert!(!glob_match("a?c", "abbc"));
    }

    #[test]
    fn test_glob_complex() {
        assert!(glob_match("*.test.js", "app.test.js"));
        assert!(glob_match("file?.txt", "file1.txt"));
        assert!(!glob_match("file?.txt", "file10.txt"));
    }
}
