//! File manipulation commands: ls, cat, touch, mkdir, rmdir, rm, mv, cp

use futures_lite::io::AsyncWriteExt;
use lexopt::prelude::*;
use runtime_macros::{shell_command, shell_commands};

use super::super::ShellEnv;
use super::{make_parser, parse_common, CommandFn};

/// File manipulation commands.
pub struct FileCommands;

#[shell_commands]
impl FileCommands {
    /// ls - list directory
    #[shell_command(
        name = "ls",
        usage = "ls [-la] [PATH]...",
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
        
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = FileCommands::show_help("ls") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut long_format = false;
            let mut show_all = false;
            let mut paths: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('l') => long_format = true,
                    Short('a') => show_all = true,
                    Value(val) => paths.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
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
                        items.sort_by(|a, b| a.0.cmp(&b.0));

                        for (name, meta) in items {
                            if long_format {
                                let size = meta.len();
                                let is_dir = if meta.is_dir() { "d" } else { "-" };
                                let line = format!("{} {:>8}  {}\n", is_dir, size, name);
                                let _ = stdout.write_all(line.as_bytes()).await;
                            } else {
                                let display = if meta.is_dir() {
                                    format!("{}/\n", name)
                                } else {
                                    format!("{}\n", name)
                                };
                                let _ = stdout.write_all(display.as_bytes()).await;
                            }
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
                if p.starts_with('/') { p.to_string() } else { format!("{}/{}", cwd, p) }
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
                if p.starts_with('/') { p.to_string() } else { format!("{}/{}", cwd, p) }
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
        mut stderr: piper::Writer,
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
                if p.starts_with('/') { p.to_string() } else { format!("{}/{}", cwd, p) }
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
                let _ = stdout.write_all(format!("--- {}\n", files[0]).as_bytes()).await;
                let _ = stdout.write_all(format!("+++ {}\n", files[1]).as_bytes()).await;
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
                            let _ = stdout.write_all(format!("{}c{}\n", i + 1, i + 1).as_bytes()).await;
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
            
            if has_diff { 1 } else { 0 }
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
